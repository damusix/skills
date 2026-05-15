# 49 — TLS / SSL

PostgreSQL's TLS surface is a server-side GUC family (`ssl`, `ssl_cert_file`, `ssl_key_file`, …) plus a client-side libpq parameter family (`sslmode`, `sslrootcert`, `channel_binding`, …) that must agree about what handshake to perform and what to verify. This file covers the server, the client, the SCRAM channel-binding interaction, certificate rotation, and the PG17/PG18 changes (direct TLS negotiation, TLS 1.3 cipher control, `ssl_groups` rename).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Decision matrix](#decision-matrix)
    - [Server-side: enabling TLS](#server-side-enabling-tls)
    - [Server GUCs (`ssl_*`)](#server-gucs-ssl_)
    - [Client-side: the six `sslmode` values](#client-side-the-six-sslmode-values)
    - [Client cert / key / root cert / CRL](#client-cert--key--root-cert--crl)
    - [Channel binding (SCRAM-SHA-256-PLUS)](#channel-binding-scram-sha-256-plus)
    - [Direct TLS negotiation (PG17+)](#direct-tls-negotiation-pg17)
    - [Certificate rotation](#certificate-rotation)
    - [`require_auth` and client-side hardening (PG16+)](#require_auth-and-client-side-hardening-pg16)
    - [TLS 1.3 ciphers and `ssl_groups` (PG18)](#tls-13-ciphers-and-ssl_groups-pg18)
    - [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file when the question is about *transport encryption and certificate handling* between client and server. Specifically:

- Turning TLS on for a new cluster or hardening an existing one.
- Picking the right `sslmode` for an application (`prefer` is the libpq default and is **wrong** for production).
- Issuing, deploying, and rotating server certificates without downtime.
- Setting up client-certificate authentication (`cert` method or `clientcert=verify-full`).
- Enabling SCRAM channel binding to defeat man-in-the-middle attacks even when a CA is compromised.
- Adopting PG17 direct TLS negotiation (`sslnegotiation=direct`) to skip a round trip.
- Auditing for the PG14+ `clientcert=verify-ca`/`verify-full`-only rule, the PG18 `ssl_ecdh_curve` → `ssl_groups` rename, or the PG18 `ssl_tls13_ciphers` addition.

The companion files are [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) (which `hostssl` records to write, and how `clientcert=` combines with auth methods), [`46-roles-privileges.md`](./46-roles-privileges.md) (what the connection can do once accepted), and [`50-encryption-pgcrypto.md`](./50-encryption-pgcrypto.md) (column-level encryption at rest — a different problem entirely).

## Mental Model

Five rules — each names a misconception:

1. **TLS is opt-in on both ends and *both ends must agree*.** The server publishes a cert when `ssl = on` is set in `postgresql.conf`. The client decides whether to require TLS and whether to verify the server's identity via the libpq `sslmode` parameter. `pg_hba.conf` is a third axis: `hostssl` records match only TLS connections, `hostnossl` only plaintext, and a bare `host` matches both[^pg-hba-hostssl]. All three layers must be configured deliberately. **Defeats:** "I set `ssl = on`, so the connections are encrypted." They are only encrypted if (a) the client requested TLS, (b) the negotiation succeeded, and (c) the `pg_hba.conf` line that matched required it.

2. **`sslmode = verify-full` is the production default; `prefer` (libpq's actual default) is not.** Verbatim from the docs: *"prefer ... it makes no sense from a security point of view, and it only promises performance overhead if possible. It is only provided as the default for backward compatibility, and is not recommended in secure deployments."*[^sslmode-prefer-quote] `verify-full` checks the server certificate against `sslrootcert` AND verifies the hostname matches[^sslmode-verify-full]. Any production application connection string should pin `sslmode=verify-full`. **Defeats:** "We're using TLS — the default is fine." The default is `prefer`, which silently downgrades to plaintext if the server doesn't support TLS, and even when TLS works does not verify the certificate.

3. **A trusted CA is not enough on its own — SCRAM channel binding (`SCRAM-SHA-256-PLUS`) defeats MITM even with a compromised CA.** When the client uses SCRAM with channel binding, the server's TLS certificate hash is bound into the SCRAM exchange. A MITM holding a valid but different certificate for the same hostname cannot complete the SCRAM handshake even if the client trusts both certificates. Verbatim: *"The channel binding type used by PostgreSQL is `tls-server-end-point`."*[^channel-binding-quote] Available in PG11+ for SCRAM auth over TLS[^channel-binding-pg11]. **Defeats:** "If I trust the CA, I'm safe." A misissued or hostile-CA certificate still authenticates as the server's hostname; channel binding catches the mismatch in the certificate-key-pair fingerprint.

4. **Server certificate rotation is a SIGHUP, not a restart — but only if you do it right.** Replace `server.crt` and `server.key` files in place, then `pg_ctl reload` (or `SELECT pg_reload_conf()`). The server picks up the new cert for *new* connections; existing connections keep their already-negotiated session keys. Files must remain at the paths in `ssl_cert_file` / `ssl_key_file` (default `server.crt` / `server.key` in `$PGDATA`). The key file must be `chmod 0600` and owned by the postgres user, or `chmod 0640` owned by root with group `postgres`[^ssl-key-perms]. **Defeats:** "I need a maintenance window for cert rotation." You do not, if you treat the cert/key files as configuration that reloads on SIGHUP.

5. **TLS 1.2 and TLS 1.3 use different cipher controls; the `ssl_ciphers` GUC does NOT apply to TLS 1.3.** Verbatim: *"there is no setting that controls the cipher choices used by TLS version 1.3"*[^ssl-ciphers-no-tls13] in PG ≤ 17. PG18 adds `ssl_tls13_ciphers`[^pg18-ssl-tls13-ciphers]. Any cluster on TLS 1.3 (which is the default upper bound) with cipher restrictions written against TLS 1.2 is **only partially restricting** its allowed ciphers. **Defeats:** "I set `ssl_ciphers` to HIGH-only; we're fine." Only TLS 1.2 and below are constrained; the TLS 1.3 ciphersuite is whatever OpenSSL's default is, which is fine in practice but is not what most operators think they've configured.

## Syntax / Mechanics

### Decision matrix

| You want to … | Server GUC(s) | Client `sslmode` / param | Notes |
|---|---|---|---|
| Production baseline: TLS required, server verified | `ssl=on`, certs in place | `sslmode=verify-full`, `sslrootcert=...` | Pin `verify-full` on every connection string |
| Self-signed cert in dev | `ssl=on`, self-signed | `sslmode=require` | `require` encrypts but does not verify — dev only |
| MITM-resistant even with compromised CA | `ssl=on`, password_encryption=`scram-sha-256` | `sslmode=verify-full`, `channel_binding=require` | PG11+; needs SCRAM creds, not MD5 |
| Pin to OS trust store | `ssl=on` | `sslrootcert=system` | PG16+; verbatim "this special value forces `verify-full`"[^sslrootcert-system] |
| Disable TLS entirely (intra-host UNIX socket only) | `ssl=off` | `sslmode=disable` | Use only on Unix sockets; never over TCP |
| Client certificate authentication | `ssl=on`, `ssl_ca_file=` | `sslmode=verify-full`, `sslcert=...`, `sslkey=...` | Pair with `cert` method or `clientcert=verify-full` in `pg_hba.conf` |
| Skip a round trip on connect | `ssl=on`, OpenSSL 1.0.2+ | `sslnegotiation=direct` | PG17+; requires ALPN; server must be PG17+ too |
| Rotate certs without restart | replace files | n/a | `pg_ctl reload` after replacement; reuse keys until reload |
| Pin which auth methods the client accepts | n/a | `require_auth=scram-sha-256` | PG16+; defends against a downgrade to weaker server |
| Restrict TLS 1.3 ciphersuite | `ssl_tls13_ciphers=` | n/a | PG18+; pre-PG18, TLS 1.3 ciphers are uncontrollable |
| Configure ECDH groups | `ssl_groups=X25519:prime256v1` | n/a | PG18+ name; pre-PG18 was single-value `ssl_ecdh_curve` |

**Smell signals.**

- Connection string uses `sslmode=require` in production — it encrypts but does not authenticate the server. Either upgrade to `verify-full` or document why authentication is unnecessary.
- The driver ships with `sslmode=prefer` as its default and the application has not overridden it — silently allows plaintext fallback if the server's `pg_hba.conf` has a permissive `host` rule.
- `ssl_ciphers` is set in `postgresql.conf` but `ssl_min_protocol_version` is `TLSv1.2` (the default) — TLS 1.3 negotiates without `ssl_ciphers` having any effect on its cipher choice.

### Server-side: enabling TLS

The minimum: set `ssl = on`, place `server.crt` and `server.key` in `$PGDATA` (or wherever `ssl_cert_file` / `ssl_key_file` point), reload. Verbatim:

> *"The server will listen for both normal and SSL connections on the same TCP port, and will negotiate with any connecting client on whether to use SSL."*[^ssl-tcp-listen]

PostgreSQL serves both plain and TLS traffic on the same TCP port (`5432` by default). The first byte of the protocol determines which (the client sends a TLS-request startup packet to ask for the upgrade). Selecting `hostnossl` / `hostssl` in `pg_hba.conf` is how the **server's policy** rejects one or the other after the negotiation has happened.

Key file permissions are enforced verbatim by the docs:

> *"The server will not load a key whose permissions are wider than 0600 if the file is owned by the database user, or 0640 if it is owned by root."*[^ssl-key-perms]

A passphrase-protected key requires either entering the passphrase interactively on each restart or configuring `ssl_passphrase_command` to script-supply it.

#### What happens during the handshake

When TLS is configured (server side `ssl = on`, client side `sslmode` ≥ `require`), the connection proceeds:

1. **TCP connect** to port 5432 (or whatever `port =` is set to).
2. **Client sends SSL request packet.** A 4-byte length prefix + `80877103` (the magic number) tells the server "I want to upgrade to TLS." Pre-PG17 this is always how TLS starts.
3. **Server responds with `S` (yes, supported) or `N` (no, plaintext only).** If the server says `N` and the client's `sslmode` is `require`/`verify-*`, the client aborts. If `sslmode = prefer`/`allow`, the client continues plaintext.
4. **TLS handshake.** Server sends certificate; client verifies against `sslrootcert` (if `sslmode = verify-*`); ALPN is negotiated; cipher and protocol version are agreed.
5. **Postgres startup packet.** Now inside the TLS tunnel, the client sends the startup packet with database, user, application_name, etc.
6. **`pg_hba.conf` matching.** The server picks the first matching rule. `hostssl` matches; `hostnossl` does not. The auth method (e.g., `scram-sha-256`) drives the next round of messages.

Direct TLS negotiation (PG17+ with `sslnegotiation=direct`) skips step 2 entirely: the client sends a TLS ClientHello as the first byte. The server recognizes the TLS handshake byte pattern and routes the connection directly into the TLS stack, saving one full round trip.

### Server GUCs (`ssl_*`)

| GUC | Default | Notes |
|---|---|---|
| `ssl` | `off` | Master switch. Must be `on` for any TLS to occur. Context `postmaster` — restart required to **change between on/off**; reloadable for cert/key file path changes once enabled[^ssl-context]. |
| `ssl_ca_file` | empty | PEM-format CA certificate(s) for verifying client certs. Required for `clientcert=verify-ca` / `verify-full` or auth method `cert`[^ssl-ca-file]. |
| `ssl_cert_file` | `server.crt` | Server certificate. Relative paths resolved against `$PGDATA`[^ssl-cert-file]. |
| `ssl_crl_file` | empty | Certificate Revocation List (PEM). Optional but recommended in environments that revoke client certs[^ssl-crl-file]. |
| `ssl_crl_dir` | empty | Directory of CRLs (PG14+)[^pg14-ssl-crl-dir]. Replaces or supplements `ssl_crl_file`. |
| `ssl_key_file` | `server.key` | Server private key. Permission rules above[^ssl-key-perms]. |
| `ssl_ciphers` | `HIGH:MEDIUM:+3DES:!aNULL` | OpenSSL cipher list **for TLS ≤ 1.2 only**. No effect on TLS 1.3[^ssl-ciphers-no-tls13]. |
| `ssl_tls13_ciphers` | empty (OpenSSL default) | PG18+. Colon-separated TLS 1.3 ciphersuite list[^pg18-ssl-tls13-ciphers]. |
| `ssl_prefer_server_ciphers` | `on` | Whether the server's order wins during cipher negotiation. Generally leave `on`[^ssl-prefer]. |
| `ssl_ecdh_curve` | `prime256v1` (pre-PG18) | Single ECDH curve. Renamed to `ssl_groups` in PG18[^pg18-ssl-groups]. |
| `ssl_groups` | `X25519:prime256v1` (PG18+) | PG18+ name; accepts colon-separated list; old name still works[^pg18-ssl-groups]. |
| `ssl_min_protocol_version` | `TLSv1.2` | Floor of negotiated TLS version. Set to `TLSv1.3` to forbid older protocols[^ssl-min]. |
| `ssl_max_protocol_version` | empty (no max) | Optional ceiling[^ssl-max]. |
| `ssl_dh_params_file` | empty | DH parameters for non-EC key exchange[^ssl-dh]. |
| `ssl_passphrase_command` | empty | Shell command to obtain a key passphrase at server start[^ssl-passphrase]. |
| `ssl_passphrase_command_supports_reload` | `off` | Whether the passphrase command should be re-run on reload. Must be `on` on Windows for cert rotation via reload[^ssl-passphrase-reload]. |

### Client-side: the six `sslmode` values

Verbatim from `libpq-connect.html`[^sslmode-values]:

| `sslmode` | Encryption attempted? | Server cert verified? | Hostname verified? | Use case |
|---|---|---|---|---|
| `disable` | No | n/a | n/a | Trusted local socket; never on TCP |
| `allow` | Yes if server requires | No | No | Almost always wrong |
| `prefer` | Yes if server supports, else plaintext | No | No | **libpq default**; not recommended for production[^sslmode-prefer-quote] |
| `require` | Yes (fails if not) | No | No | Encrypted but not authenticated; dev only |
| `verify-ca` | Yes | Yes (chain to `sslrootcert`) | No | Encrypted + cert signed by trusted CA |
| `verify-full` | Yes | Yes | Yes | **Production default** |

The asymmetry between `verify-ca` and `verify-full` is hostname verification: `verify-ca` accepts any cert signed by the trusted CA (so a MITM with a valid cert for *some other* hostname succeeds); `verify-full` requires the cert's Subject Alt Name or CN to match the hostname in the connection string[^verify-full-hostname].

PG15 added IP address matching against SAN entries (previously only DNS names were checked), allowing `sslmode=verify-full` against IP-literal connection strings when the cert has the IP in its SAN[^pg15-san-ip].

### Client cert / key / root cert / CRL

Default file locations (libpq side):

| File | Default path | Purpose |
|---|---|---|
| `sslcert` | `~/.postgresql/postgresql.crt` | Client certificate to present to server[^libpq-default-paths] |
| `sslkey` | `~/.postgresql/postgresql.key` | Client private key (0600 / 0640 rules same as server)[^libpq-default-paths] |
| `sslrootcert` | `~/.postgresql/root.crt` | CA(s) used to verify server cert; special value `system` (PG16+) loads OS trust store and forces `verify-full`[^sslrootcert-system] |
| `sslcrl` | `~/.postgresql/root.crl` | CRL for server cert revocation checking[^libpq-default-paths] |
| `sslpassword` | empty | Passphrase for an encrypted `sslkey`[^sslpassword] |
| `sslcertmode` | `allow` | PG16+. Whether to send a client cert: `disable` / `allow` / `require`[^pg16-sslcertmode] |

When `sslmode=verify-full` and `sslrootcert=system` are both set, the libpq client uses the OS-provided trust store (e.g., `/etc/ssl/certs` on Debian, the macOS Keychain), which means the cluster's server cert needs to be signed by a publicly-trusted CA (Let's Encrypt, an internal CA installed cluster-wide, etc.).

### Channel binding (SCRAM-SHA-256-PLUS)

PostgreSQL SCRAM supports the `tls-server-end-point` channel-binding type[^channel-binding-quote]. With channel binding active, the server's TLS certificate hash is mixed into the SCRAM handshake; a MITM holding a different valid cert for the same hostname is detected.

Client side: the `channel_binding` libpq parameter has three values:

| `channel_binding` | Behavior |
|---|---|
| `disable` | Reject channel binding; use plain SCRAM-SHA-256 |
| `prefer` (default if SSL-compiled) | Use channel binding if both sides support it; fall back if not |
| `require` | Refuse to connect if channel binding cannot be negotiated |

Verbatim: *"only supported over SSL connections with PostgreSQL 11 or later servers using SCRAM authentication."*[^channel-binding-server-version]

For production hardening: pair `sslmode=verify-full` with `channel_binding=require`. If the server presents an MD5-only password for the role, SCRAM cannot proceed and the connection fails — which is the desired behavior in a SCRAM-only environment.

> [!NOTE] PostgreSQL 18
> PG18 added SCRAM passthrough support for `postgres_fdw` and `dblink` via the new `use_scram_passthrough` server option and the `scram_client_key` / `scram_server_key` columns in `pg_authid`[^pg18-scram-passthrough]. This means a FDW user mapping can forward the SCRAM credentials of the calling user to the remote server without storing a plaintext password locally.

### Direct TLS negotiation (PG17+)

Pre-PG17 the TLS handshake required a round-trip: the libpq client sent a startup message asking the server "are you SSL-capable?", the server responded "yes", then TLS began. PG17 added direct TLS negotiation:

> [!NOTE] PostgreSQL 17
> Verbatim: *"Allow TLS connections without requiring a network round-trip negotiation (Heikki Linnakangas, Greg Stark). This is enabled by libpq option sslnegotiation=direct. This requires ALPN, and only works on PostgreSQL 17 and later servers."*[^pg17-sslneg]

Client side: set `sslnegotiation=direct`. Server side: nothing changes — the server detects an immediate TLS handshake byte pattern and switches into TLS mode. Both libpq client and server must be PG17+ and ALPN must be available in the OpenSSL build.

The `sslnegotiation` parameter values:

| `sslnegotiation` | Behavior |
|---|---|
| `postgres` (default) | Original two-round-trip negotiation (universally compatible) |
| `direct` | Skip the negotiation; send TLS ClientHello immediately. Saves one RTT |

Operationally direct mode shaves ~20–100 ms off connect latency on cross-region connections. For high-frequency short-lived connections (or applications without a connection pooler) the win can be noticeable.

### Certificate rotation

Verbatim: *"To rotate the server cert/key without server restart, you can reload the configuration file."*[^cert-rotation] The mechanics:

1. Place the new cert and key in the same paths (`ssl_cert_file`, `ssl_key_file`).
2. Ensure the key file permissions remain `0600` (or `0640` for root-owned with group postgres).
3. `pg_ctl reload` or `SELECT pg_reload_conf();` — both send SIGHUP to the postmaster.
4. The new cert is used for *new* connections starting from that moment.
5. **Existing connections keep their existing TLS session keys** — they continue using the old cert's negotiated keys until they disconnect. This is normal and not a security risk (TLS keys are independent of the cert validity for the duration of an already-established session).

Verbatim warning for Windows:

> *"On Windows, `ssl_passphrase_command_supports_reload` must be set to `on` to allow the passphrase command to be re-run during a reload, otherwise the reload will fail."*[^ssl-passphrase-reload]

The certificate file paths themselves cannot be changed via reload (changing `ssl_cert_file` is a `postmaster`-context GUC and requires restart on **some** versions; check `pg_settings.context` for your version before assuming).

### `require_auth` and client-side hardening (PG16+)

> [!NOTE] PostgreSQL 16
> Verbatim: *"Add libpq function PQchangePassword() to hash password changes"*[^pg17-pqchangepassword] and *"Add libpq option require_auth that limits the authentication methods that a client will accept (Jacob Champion)"*[^pg16-require-auth].

The `require_auth` parameter is a client-side allowlist that names which authentication methods the libpq client will accept from the server. If the server tries to use any other method (including a downgrade attack from SCRAM to MD5 or password), the client refuses.

Values:

- `password` — cleartext password (rejected over TLS by sane deployments; never recommended)
- `md5` — MD5 challenge (deprecated)
- `scram-sha-256` — SCRAM
- `gss` / `sspi` — Kerberos
- `cert` — TLS client certificate (no password)
- `none` — `trust` (no authentication)
- Comma-separated combinations: `scram-sha-256,gss`
- Negation: `!password` accepts everything except cleartext password

Production-hardening recipe: every application connection string should include `require_auth=scram-sha-256` (or `scram-sha-256,cert` if some services use TLS client certs). This defends against a hostile or misconfigured server that downgrades the auth method.

### TLS 1.3 ciphers and `ssl_groups` (PG18)

> [!NOTE] PostgreSQL 18
> Verbatim: *"Add server variable ssl_tls13_ciphers to control TLS 1.3 ciphersuites used (Daniel Gustafsson)"*[^pg18-ssl-tls13-ciphers] and *"Rename server variable ssl_ecdh_curve to ssl_groups, and accept multiple curves separated by colons (Daniel Gustafsson)"*[^pg18-ssl-groups].

The pre-PG18 `ssl_ecdh_curve` accepted only one curve. PG18 `ssl_groups` accepts a colon-separated list (matching the OpenSSL `SSL_CTX_set1_groups_list` API) and the default expanded to `X25519:prime256v1`. The old `ssl_ecdh_curve` name continues to work as an alias.

Recipe for a modern TLS 1.3 baseline on PG18:

```ini
ssl = on
ssl_min_protocol_version = 'TLSv1.3'
ssl_tls13_ciphers = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256'
ssl_groups = 'X25519:prime256v1'
```

On clusters with mixed-version clients that may not support TLS 1.3, leave `ssl_min_protocol_version = 'TLSv1.2'` and add `ssl_ciphers = 'HIGH:!aNULL:!RC4:!3DES'` for the TLS 1.2 path.

### Per-version timeline

| Version | Change | Source |
|---|---|---|
| PG14 | `ssl_crl_dir` directory-of-CRLs (server) and `sslcrldir` (libpq); SSL compression removed entirely from server; SNI (`sslsni`) added in libpq; `clientcert` accepts only `verify-ca`/`verify-full` (the old `1`/`0`/`no-verify` removed); `clientname=DN` for full distinguished-name matching; `password_encryption` default `md5` → `scram-sha-256` | [^pg14-ssl-changes] |
| PG15 | Cert SAN entries can include IP addresses for `verify-full` matching; `PQsslAttribute()` available without an active connection; query cancellation reuses the same TCP options | [^pg15-ssl-changes] |
| PG16 | `sslcertmode` libpq parameter (`disable`/`allow`/`require`); `sslrootcert=system` loads OS trust store and forces `verify-full`; "additional details during client certificate failures"; libpq `require_auth` parameter for client-side method allowlist; `scram_iterations` GUC for SCRAM stretching cost; subscription replication can run without storing a password locally | [^pg16-ssl-changes] |
| PG17 | `sslnegotiation=direct` for one-RTT TLS startup (requires ALPN); libpq `PQchangePassword()` hashes client-side; `log_connections` emits a line for `trust` connections; encrypted cancel requests; OpenSSL 1.0.1 support removed; FIPS-mode test compatibility | [^pg17-ssl-changes] |
| PG18 | `ssl_tls13_ciphers` GUC (TLS 1.3 cipher control); `ssl_ecdh_curve` → `ssl_groups` rename with multi-value support; 256-bit cancel keys (wire protocol 3.2); SCRAM passthrough for `postgres_fdw` / `dblink`; `oauth` auth method added (the first new method since PG10 SCRAM); MD5 deprecation warnings via `md5_password_warnings`; `sslkeylogfile` libpq parameter (Wireshark debugging) | [^pg18-ssl-changes] |

## Examples / Recipes

### Recipe 1 — Production baseline: TLS required, server verified, channel binding

Server `postgresql.conf`:

```ini
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
ssl_ca_file = 'ca.crt'                    # for client cert auth, optional otherwise
ssl_min_protocol_version = 'TLSv1.2'
ssl_prefer_server_ciphers = on
ssl_ciphers = 'HIGH:!aNULL:!RC4:!3DES'
password_encryption = 'scram-sha-256'     # PG14+ default; reaffirm explicitly
```

Server `pg_hba.conf`:

```conf
# Force TLS for any TCP connection
hostssl   all   all   0.0.0.0/0   scram-sha-256
hostssl   all   all   ::/0        scram-sha-256
# Final catch-all: reject any non-TLS TCP attempt
host      all   all   0.0.0.0/0   reject
host      all   all   ::/0        reject
```

Application connection string (libpq URI form):

```
postgresql://app_user@db.example.com:5432/appdb?sslmode=verify-full&sslrootcert=/etc/ssl/certs/internal-ca.crt&channel_binding=require&require_auth=scram-sha-256
```

The combination defeats every common attack: plaintext fallback (rejected by `hostssl` + `sslmode=verify-full`), MITM via valid-cert-for-wrong-host (rejected by hostname verification), MITM via compromised CA (rejected by channel binding), auth downgrade (rejected by `require_auth`).

### Recipe 2 — Self-signed cert for dev

```bash
cd $PGDATA
openssl req -new -x509 -days 3650 -nodes -text \
    -out server.crt -keyout server.key \
    -subj "/CN=localhost"
chmod 0600 server.key
```

Then in `postgresql.conf`:

```ini
ssl = on
```

Reload. The dev client uses `sslmode=require` (not `verify-*`, because the cert is self-signed). Self-signed is dev-only; staging and production require a CA-signed cert (an internal CA root is acceptable for staging).

### Recipe 2b — Internal CA-signed server certificate (production-grade)

For staging and production, use a proper CA — either an internal organization CA or a public one like Let's Encrypt. Internal CA flow:

```bash
# One-time: generate the internal CA (kept offline)
openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
    -out ca.crt -subj "/CN=Internal Postgres CA/O=Acme/C=US"

# Per-cluster: generate server key + CSR with proper SAN
openssl genrsa -out server.key 2048
chmod 0600 server.key

cat > server.cnf <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions     = v3_req
prompt             = no
[req_distinguished_name]
CN = db.example.com
[v3_req]
subjectAltName = @alt_names
[alt_names]
DNS.1 = db.example.com
DNS.2 = db-primary.example.com
IP.1  = 10.0.1.5
EOF

openssl req -new -key server.key -out server.csr -config server.cnf

# CA signs the CSR
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key \
    -CAcreateserial -out server.crt -days 365 -sha256 \
    -extensions v3_req -extfile server.cnf

# Deploy to cluster
cp server.crt server.key $PGDATA/
chmod 0600 $PGDATA/server.key
chown postgres:postgres $PGDATA/server.{crt,key}
```

Set `ssl_cert_file = 'server.crt'` and `ssl_key_file = 'server.key'` (or leave defaults), reload, and verify with Recipe 8.

The SAN block matters: clients connecting by `db.example.com` *and* by raw IP `10.0.1.5` (with PG15+ libpq) both verify cleanly under `sslmode=verify-full` because both names appear in the SAN. Without SAN entries for the IP, IP-literal connections fail `verify-full`.

### Recipe 3 — Pin OS trust store (`sslrootcert=system`)

> [!NOTE] PostgreSQL 16+
> The special value `sslrootcert=system` loads the OS-provided trust store (e.g., `/etc/ssl/certs` on Debian, the macOS Keychain) and *forces* `sslmode=verify-full`[^sslrootcert-system].

```
postgresql://app@db.example.com/appdb?sslrootcert=system
```

This is the cleanest pattern when the cluster's cert is signed by a publicly-trusted CA (Let's Encrypt, a public internal CA pre-installed cluster-wide). The application avoids managing its own `root.crt` file, and the `verify-full` requirement is enforced automatically.

### Recipe 4 — Rotate the server certificate without downtime

```bash
# 1. Stage the new cert/key
cp new-server.crt $PGDATA/server.crt.new
cp new-server.key $PGDATA/server.key.new
chmod 0600 $PGDATA/server.key.new
chown postgres:postgres $PGDATA/server.key.new

# 2. Atomic swap
mv $PGDATA/server.crt.new $PGDATA/server.crt
mv $PGDATA/server.key.new $PGDATA/server.key

# 3. Reload
pg_ctl -D $PGDATA reload
# or: psql -c "SELECT pg_reload_conf();"

# 4. Verify new cert is in use for new connections
openssl s_client -connect db.example.com:5432 -starttls postgres < /dev/null | openssl x509 -noout -dates
```

Existing connections continue to use the old cert's negotiated session keys (they don't re-handshake). New connections from the moment of reload onward use the new cert.

### Recipe 5 — Client certificate authentication

Server `pg_hba.conf`:

```conf
hostssl   appdb   app_user   10.0.0.0/8   cert clientname=CN
```

Server `postgresql.conf` (must have `ssl_ca_file` set to the CA that signed the client cert):

```ini
ssl = on
ssl_ca_file = 'client-ca.crt'
```

Client connection string:

```
postgresql://app@db.example.com/appdb?sslmode=verify-full&sslrootcert=/etc/ssl/internal-ca.crt&sslcert=/etc/ssl/client-app.crt&sslkey=/etc/ssl/client-app.key
```

Verbatim trap from `auth-cert.html`:

> *"It is redundant to use the `clientcert` option with `cert` authentication because `cert` authentication is effectively `trust` authentication with `clientcert=verify-full`."*[^cert-trap]

So `hostssl appdb app_user 10.0.0.0/8 cert` is correct; `hostssl appdb app_user 10.0.0.0/8 cert clientcert=verify-full` is redundant (but harmless).

### Recipe 6 — Channel binding required

For SCRAM credentials over TLS, force channel binding on every connection:

```
postgresql://app@db.example.com/appdb?sslmode=verify-full&channel_binding=require
```

If a future server downgrades to plain SCRAM (e.g., a misconfigured replica without proper TLS), the client refuses to connect instead of silently completing a weaker handshake. Combine with `require_auth=scram-sha-256` to also defend against an MD5 downgrade.

### Recipe 7 — PG17 direct TLS for short-lived connections

> [!NOTE] PostgreSQL 17+
> Both client and server must be PG17+. OpenSSL must support ALPN (1.0.2+).

```
postgresql://app@db.example.com/appdb?sslmode=verify-full&sslnegotiation=direct
```

For applications without a connection pooler (e.g., serverless functions) the saved RTT can drop p99 connect latency noticeably on cross-region links.

### Recipe 8 — Verify TLS configuration end-to-end

```bash
# 1. Confirm server is listening with TLS
openssl s_client -connect db.example.com:5432 -starttls postgres -showcerts < /dev/null

# 2. Inspect the negotiated cipher + protocol
openssl s_client -connect db.example.com:5432 -starttls postgres -tls1_3 < /dev/null 2>&1 | grep -E "Protocol|Cipher"

# 3. From inside the cluster: check current settings
psql -c "SELECT name, setting FROM pg_settings WHERE name LIKE 'ssl%' ORDER BY name;"

# 4. From a client session: confirm THIS connection is TLS-encrypted
psql "host=db.example.com user=app dbname=appdb sslmode=verify-full" \
     -c "SELECT ssl, version, cipher, bits FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
```

The `pg_stat_ssl` view shows `ssl = t`, the TLS version (e.g., `TLSv1.3`), the cipher, and key bits for the current session — useful for confirming the channel is what you think it is.

### Recipe 9 — Audit existing connections by encryption state

```sql
SELECT s.pid, s.usename, s.application_name, s.client_addr,
       ss.ssl, ss.version, ss.cipher, ss.bits, ss.client_dn
FROM pg_stat_activity s
LEFT JOIN pg_stat_ssl ss USING (pid)
WHERE s.backend_type = 'client backend'
ORDER BY ss.ssl NULLS FIRST, s.client_addr;
```

Rows with `ssl = false` (or NULL on a local Unix-socket connection that doesn't go through TLS at all) reveal plaintext clients. Pair with `pg_hba.conf` tightening to migrate them.

### Recipe 10 — Restrict TLS to 1.3 only

```ini
ssl = on
ssl_min_protocol_version = 'TLSv1.3'
# PG18+ only — uncomment if available:
# ssl_tls13_ciphers = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256'
ssl_groups = 'X25519:prime256v1'    # PG18+; pre-PG18 use ssl_ecdh_curve
```

Verify all clients support TLS 1.3 *before* applying this — libpq 11+ does; some legacy drivers (older Java, older Go) may not.

### Recipe 11 — Audit GUC drift from defaults

```sql
SELECT name, setting, source, context
FROM pg_settings
WHERE name LIKE 'ssl%' OR name LIKE 'password_encryption' OR name = 'scram_iterations'
  AND source <> 'default'
ORDER BY name;
```

Reveals which TLS-related GUCs are non-default (`source = 'configuration file'`, `'command line'`, etc.) — a baseline diff between a hardened cluster and its defaults.

### Recipe 12 — Diagnose "no pg_hba.conf entry" errors over TLS

If the client sees `no pg_hba.conf entry for host "10.1.2.3", user "app", database "appdb", SSL on`, the server's `pg_hba.conf` has **no rule** matching this combination. Common causes:

1. Connection is TLS but every rule for the IP range is `hostnossl`.
2. Connection is plaintext but every rule for the IP range is `hostssl`.
3. The IP/CIDR ranges in `pg_hba.conf` don't include the client's source IP.

Diagnostic SQL (works only after the *next* successful connection):

```sql
SELECT line_number, type, database, user_name, address, netmask, auth_method
FROM pg_hba_file_rules
WHERE error IS NULL
ORDER BY line_number;
```

Cross-reference [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) Recipe 12 for the full no-pg_hba-entry decision tree.

### Recipe 13 — TLS for streaming replication

Replication connections honor the same TLS surface as application connections. The standby's `primary_conninfo` is a libpq connection string with full `sslmode`/`sslrootcert`/`channel_binding` support:

```ini
# postgresql.conf on the standby
primary_conninfo = 'host=primary.example.com port=5432 user=replicator
    application_name=standby01
    sslmode=verify-full
    sslrootcert=/etc/ssl/internal-ca.crt
    sslcert=/etc/ssl/replicator.crt
    sslkey=/etc/ssl/replicator.key
    channel_binding=require'
primary_slot_name = 'standby01'
```

Server-side `pg_hba.conf` on the primary:

```conf
hostssl   replication   replicator   10.0.0.0/8   scram-sha-256
```

Notes:

- The `replication` pseudo-database name in `pg_hba.conf` matches the physical-replication protocol, not a real database (see [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) gotcha #3).
- The standby's libpq state is inspectable in `pg_stat_ssl` on the **primary** (the walsender backend) — confirm replication traffic is encrypted by joining `pg_stat_replication` to `pg_stat_ssl` on PID.
- Logical replication subscriptions (`CREATE SUBSCRIPTION`) take the same connection string and the same TLS rules apply.

### Recipe 14 — Use `sslkeylogfile` for protocol-level debugging (PG18+)

> [!NOTE] PostgreSQL 18+
> The libpq `sslkeylogfile` parameter writes the TLS session keys to a file in NSS Key Log format. Wireshark can read this file to decrypt captured traffic for debugging.

```
postgresql://app@db.example.com/appdb?sslmode=verify-full&sslkeylogfile=/tmp/pg-tls-keys.log
```

WARNING: **Anyone with read access to that file can decrypt every captured session** keyed off it. Use this only for debugging, only on isolated test clusters, and delete the key log immediately afterwards.

## Gotchas / Anti-patterns

1. **`sslmode=prefer` is the libpq default and silently allows plaintext.** Verbatim: *"It is only provided as the default for backward compatibility, and is not recommended in secure deployments."*[^sslmode-prefer-quote] Always set `sslmode=verify-full` explicitly in production connection strings.

2. **`ssl=on` alone does not require TLS — it only *enables* it.** Without a `hostnossl ... reject` (or, more commonly, *no* `host` records matching the source IP and only `hostssl` records), a client connecting with `sslmode=disable` still completes a plaintext connection on the same port.

3. **`verify-ca` is not `verify-full`.** `verify-ca` accepts any cert signed by your trusted CA — including a cert legitimately issued for `attacker.example.com` that an attacker uses to MITM `db.example.com`. Use `verify-full` to bind the cert to the hostname.

4. **The libpq default for `channel_binding` is `prefer`, not `require`.** A misconfigured server that offers plain SCRAM gets a successful but unprotected exchange. Set `channel_binding=require` for any production application using SCRAM.

5. **`ssl_ciphers` does NOT apply to TLS 1.3.** Verbatim: *"there is no setting that controls the cipher choices used by TLS version 1.3"*[^ssl-ciphers-no-tls13] pre-PG18. PG18 adds `ssl_tls13_ciphers` to fix this. A `ssl_ciphers` setting that excludes weak ciphers is **only restricting TLS 1.2 connections**.

6. **PG14 removed `clientcert=1`, `clientcert=0`, and `clientcert=no-verify`.** Carry-forward `pg_hba.conf` from PG13 with `clientcert=1` will fail to load on PG14+[^pg14-clientcert]. Replace with `clientcert=verify-ca` or `clientcert=verify-full`.

7. **`clientcert` with auth method `cert` is redundant.** Verbatim: *"It is redundant to use the `clientcert` option with `cert` authentication because `cert` authentication is effectively `trust` authentication with `clientcert=verify-full`."*[^cert-trap] No harm, but signals that the operator didn't understand the method.

8. **The server key file's permissions must be 0600 (or 0640 for root-owned).** Verbatim: *"The server will not load a key whose permissions are wider than 0600 if the file is owned by the database user, or 0640 if it is owned by root."*[^ssl-key-perms] A wider mode causes startup to fail with a permission error.

9. **`hostssl` matches the negotiated protocol, not the *requested* protocol.** A client asking for TLS that negotiation fails on falls back to plaintext (with `sslmode=prefer`), which then matches a `host` rule, not `hostssl`. Pair `sslmode=verify-full` with a final `host ... reject` row.

10. **PG17 `sslnegotiation=direct` requires ALPN.** OpenSSL must be 1.0.2+ (it is, on modern systems) AND must be configured to support ALPN. Falls back to standard negotiation if either side lacks ALPN — silently slower, but not broken.

11. **`sslrootcert=system` only works on PG16+ libpq.** On PG≤15 the value `system` is interpreted as a literal file path, which will not exist, causing connect failures.

12. **PG18 renamed `ssl_ecdh_curve` to `ssl_groups`.** Old name still works as an alias[^pg18-ssl-groups], but new configuration should use `ssl_groups` and may want to set multiple curves (e.g., `X25519:prime256v1`).

13. **TLS does not encrypt data at rest, only in transit.** For column-level at-rest encryption see [`50-encryption-pgcrypto.md`](./50-encryption-pgcrypto.md). For full-disk encryption use the OS layer (LUKS, EFS at-rest encryption, etc.) — Postgres has no in-core TDE.

14. **`pg_stat_ssl` shows the encryption state but does not log historical sessions.** To audit "was this connection encrypted?" after the fact, you need `log_connections = on` (PG17+ logs every accepted connection, including `trust` connections that previously left no log line[^pg17-trust-log]) plus a log line parser.

15. **Reload does not change `ssl=on/off` itself in some configurations.** Toggling `ssl` between `on` and `off` requires a restart on most builds. Toggling the cert/key *paths* (or the file contents at the same path) is reloadable.

16. **Self-signed certificates pinned via `sslrootcert` are operationally fragile.** Cert expiry rotates secretly until a connection fails. Use a real CA (internal CA or Let's Encrypt) for any persistent environment.

17. **OpenSSL FIPS mode interacts with cipher selection in non-obvious ways.** `ssl_ciphers = 'HIGH:!aNULL'` may be silently restricted by FIPS to a subset. Verify with `openssl s_client` what actually negotiates.

18. **`ssl_passphrase_command` runs at server start.** If the command requires interactive input (e.g., prompts on a TTY), the server will hang during startup. Use `pass` (the password manager), a secrets-vault sidecar, or a script that pulls from a secrets API.

19. **Cert rotation through reload requires the file *paths* unchanged.** Changing `ssl_cert_file` to point to a new path is a postmaster-context GUC and may require a restart.

20. **PG18 `sslkeylogfile` is a debugging feature, not a logging feature.** Any TLS captures with the key log file can be decrypted — never enable it on production.

21. **`require_auth=scram-sha-256` fails closed if the role has only an MD5 password.** That's the desired behavior, but during a SCRAM rollout it's the first source of "we can't connect" tickets. Audit role password hashes (`pg_authid.rolpassword LIKE 'SCRAM-SHA-256$%'`) before deploying `require_auth`.

22. **Connection poolers (PgBouncer) terminate TLS at the pooler.** The application sees TLS to the pooler; the pooler-to-server hop may or may not be TLS depending on its config. Configure `server_tls_sslmode` in PgBouncer 1.21+ for the pooler-to-server hop[^pgbouncer-tls].

23. **PG18 OAuth requires a validator library AND libcurl support.** The PG18 `oauth` auth method depends on `--with-libcurl` being enabled at build time and the `oauth_validator_libraries` GUC being set[^pg18-oauth-validator]. A managed environment that lacks the validator library cannot use OAuth even if PG18 is the deployed version.

24. **Cert expiry has no in-server warning.** Postgres does not log "your cert expires in 30 days" — that's the operator's job. Build a monitoring check that runs `openssl x509 -in $PGDATA/server.crt -noout -enddate` weekly and alerts at 30 / 14 / 7 / 1 days remaining. Cert expiry causes new connections to fail (`SSL error: certificate verify failed`); existing connections keep working until they reconnect.

25. **`SSL connection has been closed unexpectedly`** is usually a server-side TLS failure (e.g., bad cert path, key permissions wider than 0600, OpenSSL version mismatch). Check `pg_log` on the server side first; the client's error is intentionally vague to avoid leaking server-state details to an unauthenticated client.

26. **Replication slot xmin retention does NOT pause for TLS handshakes.** A walsender connecting and failing the TLS handshake repeatedly still advances the slot's `wal_status` toward `lost` if connection retries are slower than WAL generation. See [`75-replication-slots.md`](./75-replication-slots.md) for slot retention thresholds.

## See Also

- [`46-roles-privileges.md`](./46-roles-privileges.md) — what the role can do once authentication succeeds; SCRAM password hashes in `pg_authid`
- [`47-row-level-security.md`](./47-row-level-security.md) — row filtering applied after auth
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — which clients can attempt to connect; `hostssl` / `hostnossl` mechanics
- [`50-encryption-pgcrypto.md`](./50-encryption-pgcrypto.md) — column-level encryption at rest
- [`51-pgaudit.md`](./51-pgaudit.md) — auditing including connection events
- [`53-server-configuration.md`](./53-server-configuration.md) — GUC contexts (postmaster vs sighup vs user)
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_stat_ssl`, `pg_hba_file_rules`, `pg_settings` introspection
- [`73-streaming-replication.md`](./73-streaming-replication.md) — TLS for replication connections
- [`81-pgbouncer.md`](./81-pgbouncer.md) — TLS at the pooler hop
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — managed-environment limitations on custom certs
- [`75-replication-slots.md`](./75-replication-slots.md) — slot xmin retention thresholds; TLS handshake failures in repeated reconnects can advance a slot toward `wal_status = lost`

## Sources

[^pg-hba-hostssl]: PostgreSQL 16 documentation, `pg_hba.conf` file. "The hostssl record type matches connection attempts made using TCP/IP, but only when the connection is made with SSL encryption. … The hostnossl record type has the opposite logic: it only matches connection attempts made over TCP/IP that do not use SSL." https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
[^sslmode-prefer-quote]: PostgreSQL 16 libpq SSL Support. *"prefer (default): I don't care about encryption, but I wish to pay the overhead of encryption if the server supports it. If the server is set up to require encryption, the client will be unable to connect."* And: *"It makes no sense from a security point of view, and it only promises performance overhead if possible. It is only provided as the default for backward compatibility, and is not recommended in secure deployments."* https://www.postgresql.org/docs/16/libpq-ssl.html
[^sslmode-values]: PostgreSQL 16 libpq Connection Parameters. The full `sslmode` value table (disable/allow/prefer/require/verify-ca/verify-full). https://www.postgresql.org/docs/16/libpq-connect.html#LIBPQ-CONNECT-SSLMODE
[^sslmode-verify-full]: PostgreSQL 16 libpq SSL Support. "verify-full: I want my data encrypted, and I accept the overhead. I want to be sure that I connect to a server that I trust, and that it's the one I specify." https://www.postgresql.org/docs/16/libpq-ssl.html
[^verify-full-hostname]: PostgreSQL 16 libpq SSL Support. "When verify-full is specified, the host name is matched against the certificate's Subject Alternative Name attribute(s), or against the Common Name attribute if no Subject Alternative Name of type dNSName is present." https://www.postgresql.org/docs/16/libpq-ssl.html
[^channel-binding-quote]: PostgreSQL 16 SASL Authentication. *"Channel binding is supported in PostgreSQL builds with SSL support. The SASL mechanism name for SCRAM with channel binding is SCRAM-SHA-256-PLUS. The channel binding type used by PostgreSQL is tls-server-end-point."* https://www.postgresql.org/docs/16/sasl-authentication.html
[^channel-binding-pg11]: PostgreSQL 11 release notes (PG11 added channel binding for SCRAM-SHA-256). https://www.postgresql.org/docs/release/11/
[^channel-binding-server-version]: PostgreSQL 16 libpq Connection Parameters, `channel_binding`. *"This option is only supported over SSL connections with PostgreSQL 11 or later servers using SCRAM authentication."* https://www.postgresql.org/docs/16/libpq-connect.html
[^ssl-tcp-listen]: PostgreSQL 16 SSL Support. *"The server will listen for both normal and SSL connections on the same TCP port, and will negotiate with any connecting client on whether to use SSL."* https://www.postgresql.org/docs/16/ssl-tcp.html
[^ssl-key-perms]: PostgreSQL 16 SSL Server File Usage. *"The server will not load a key whose permissions are wider than 0600 if the file is owned by the database user, or 0640 if it is owned by root."* https://www.postgresql.org/docs/16/ssl-tcp.html
[^ssl-context]: PostgreSQL 16 `pg_settings`. The `ssl` GUC has context `sighup` in PG16+ (reloadable). https://www.postgresql.org/docs/16/runtime-config-connection.html
[^ssl-ca-file]: PostgreSQL 16 runtime-config-connection, `ssl_ca_file`. *"Specifies the name of the file containing the SSL server certificate authority (CA)."* https://www.postgresql.org/docs/16/runtime-config-connection.html
[^ssl-cert-file]: PostgreSQL 16 runtime-config-connection, `ssl_cert_file`. *"Specifies the name of the file containing the SSL server certificate. Relative paths are relative to the data directory. This parameter can only be set in the postgresql.conf file or on the server command line."* https://www.postgresql.org/docs/16/runtime-config-connection.html
[^ssl-crl-file]: PostgreSQL 16 runtime-config-connection, `ssl_crl_file`. https://www.postgresql.org/docs/16/runtime-config-connection.html
[^pg14-ssl-crl-dir]: PostgreSQL 14 release notes. "Allow specification of the SSL certificate revocation list via ssl_crl_dir as a directory." https://www.postgresql.org/docs/release/14.0/
[^ssl-ciphers-no-tls13]: PostgreSQL 16 runtime-config-connection, `ssl_ciphers`. *"Specifies a list of SSL cipher suites that are allowed to be used by SSL connections. … This setting only impacts connections that use TLS version 1.2 and lower. There is currently no setting that controls the cipher choices used by TLS version 1.3 connections."* https://www.postgresql.org/docs/16/runtime-config-connection.html
[^pg18-ssl-tls13-ciphers]: PostgreSQL 18 release notes. *"Add server variable ssl_tls13_ciphers to control TLS 1.3 ciphersuites used (Daniel Gustafsson)."* https://www.postgresql.org/docs/release/18.0/
[^ssl-prefer]: PostgreSQL 16 runtime-config-connection, `ssl_prefer_server_ciphers`. https://www.postgresql.org/docs/16/runtime-config-connection.html
[^pg18-ssl-groups]: PostgreSQL 18 release notes. *"Rename server variable ssl_ecdh_curve to ssl_groups, and accept multiple curves separated by colons (Daniel Gustafsson). The previous name is still accepted as an alias."* https://www.postgresql.org/docs/release/18.0/
[^ssl-min]: PostgreSQL 16 runtime-config-connection, `ssl_min_protocol_version`. https://www.postgresql.org/docs/16/runtime-config-connection.html
[^ssl-max]: PostgreSQL 16 runtime-config-connection, `ssl_max_protocol_version`. https://www.postgresql.org/docs/16/runtime-config-connection.html
[^ssl-dh]: PostgreSQL 16 runtime-config-connection, `ssl_dh_params_file`. https://www.postgresql.org/docs/16/runtime-config-connection.html
[^ssl-passphrase]: PostgreSQL 16 runtime-config-connection, `ssl_passphrase_command`. https://www.postgresql.org/docs/16/runtime-config-connection.html
[^ssl-passphrase-reload]: PostgreSQL 16 runtime-config-connection, `ssl_passphrase_command_supports_reload`. https://www.postgresql.org/docs/16/runtime-config-connection.html
[^libpq-default-paths]: PostgreSQL 16 libpq SSL Support — default file locations table. https://www.postgresql.org/docs/16/libpq-ssl.html
[^sslpassword]: PostgreSQL 16 libpq Connection Parameters, `sslpassword`. https://www.postgresql.org/docs/16/libpq-connect.html
[^sslrootcert-system]: PostgreSQL 16 libpq Connection Parameters, `sslrootcert`. *"Special value system can be used to load the system trust store. This special value also overrides sslmode to verify-full unless it is explicitly set."* https://www.postgresql.org/docs/16/libpq-connect.html
[^pg16-sslcertmode]: PostgreSQL 16 release notes. "Add new libpq parameter sslcertmode to control whether a client certificate is sent to the server (Jacob Champion)." https://www.postgresql.org/docs/release/16.0/
[^pg14-clientcert]: PostgreSQL 14 release notes. "Remove non-functional clientcert values 1 and 0. The valid values for the clientcert hba option are no-verify, verify-ca, and verify-full." (Note: subsequently the 1/0/no-verify forms were tightened further.) https://www.postgresql.org/docs/release/14.0/
[^pg14-ssl-changes]: PostgreSQL 14 release notes — SSL section. https://www.postgresql.org/docs/release/14.0/
[^pg15-san-ip]: PostgreSQL 15 release notes. "Allow IP addresses to be matched against the Subject Alternative Names of a server SSL certificate." https://www.postgresql.org/docs/release/15.0/
[^pg15-ssl-changes]: PostgreSQL 15 release notes — SSL items. https://www.postgresql.org/docs/release/15.0/
[^pg16-require-auth]: PostgreSQL 16 release notes. *"Add libpq option require_auth to limit the methods used by the server during authentication (Jacob Champion)."* https://www.postgresql.org/docs/release/16.0/
[^pg16-ssl-changes]: PostgreSQL 16 release notes — SSL/authentication items. https://www.postgresql.org/docs/release/16.0/
[^pg17-sslneg]: PostgreSQL 17 release notes. *"Allow TLS connections without requiring a network round-trip negotiation (Heikki Linnakangas, Greg Stark). This is enabled by libpq option sslnegotiation=direct. This requires ALPN, and only works on PostgreSQL 17 and later servers."* https://www.postgresql.org/docs/release/17/
[^pg17-pqchangepassword]: PostgreSQL 17 release notes. "Add libpq function PQchangePassword() which hashes the password client-side to prevent the cleartext password from being sent to the server." https://www.postgresql.org/docs/release/17/
[^pg17-trust-log]: PostgreSQL 17 release notes. "Add log entries for trust authentication connections (Daniel Gustafsson)." https://www.postgresql.org/docs/release/17/
[^pg17-ssl-changes]: PostgreSQL 17 release notes — SSL/authentication items. https://www.postgresql.org/docs/release/17/
[^pg18-scram-passthrough]: PostgreSQL 18 release notes. "Allow postgres_fdw and dblink to use SCRAM passthrough for authentication." https://www.postgresql.org/docs/release/18.0/
[^pg18-oauth-validator]: PostgreSQL 18 release notes. The `oauth` method requires `oauth_validator_libraries` and builds compiled with `--with-libcurl`. https://www.postgresql.org/docs/release/18.0/
[^pg18-ssl-changes]: PostgreSQL 18 release notes — SSL/authentication items. https://www.postgresql.org/docs/release/18.0/
[^cert-rotation]: PostgreSQL 16 SSL Server File Usage section discussing reload behavior for cert/key rotation. https://www.postgresql.org/docs/16/ssl-tcp.html
[^cert-trap]: PostgreSQL 16 Certificate Authentication. *"It is redundant to use the clientcert option with cert authentication because cert authentication is effectively trust authentication with clientcert=verify-full."* https://www.postgresql.org/docs/16/auth-cert.html
[^pgbouncer-tls]: PgBouncer documentation, `server_tls_sslmode` configuration parameter for the pooler-to-server hop. https://www.pgbouncer.org/config.html

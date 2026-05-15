# Encryption — pgcrypto and the In-Core TDE Gap

The pgcrypto contrib extension provides cryptographic primitives — symmetric and asymmetric encryption, hashing, HMACs, random bytes, password-hashing — accessible as SQL functions. **Encryption happens column-by-column, server-side, with keys passed in as SQL arguments.** PostgreSQL has no in-core Transparent Data Encryption (TDE) for the heap or WAL; that capability comes only from third-party distributions (Percona, EDB, Cybertec) or filesystem/block-device encryption underneath the cluster.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model — Five Rules](#mental-model--five-rules)
- [Decision Matrix](#decision-matrix)
- [Installing pgcrypto](#installing-pgcrypto)
- [Hash Functions: digest() and hmac()](#hash-functions-digest-and-hmac)
- [Password Hashing: crypt() and gen_salt()](#password-hashing-crypt-and-gen_salt)
- [Random Bytes: gen_random_bytes()](#random-bytes-gen_random_bytes)
- [Raw Symmetric Encryption: encrypt() / decrypt()](#raw-symmetric-encryption-encrypt--decrypt)
- [PGP Symmetric Encryption: pgp_sym_encrypt() / pgp_sym_decrypt()](#pgp-symmetric-encryption-pgp_sym_encrypt--pgp_sym_decrypt)
- [PGP Asymmetric Encryption: pgp_pub_encrypt() / pgp_pub_decrypt()](#pgp-asymmetric-encryption-pgp_pub_encrypt--pgp_pub_decrypt)
- [PGP Armor and Key Inspection](#pgp-armor-and-key-inspection)
- [PG18 Additions: FIPS, builtin_crypto_enabled, sha256crypt/sha512crypt, CFB](#pg18-additions-fips-builtin_crypto_enabled-sha256cryptsha512crypt-cfb)
- [Key Management — the Actual Hard Problem](#key-management--the-actual-hard-problem)
- [The In-Core TDE Gap and Third-Party Landscape](#the-in-core-tde-gap-and-third-party-landscape)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use this file when you need to encrypt or hash data stored *inside* the database, or when you need to understand what PostgreSQL itself does *not* protect at rest. Anything moving over the wire belongs in [`49-tls-ssl.md`](./49-tls-ssl.md).

> [!WARNING] PostgreSQL has no in-core TDE
> Vanilla PostgreSQL — the upstream community release — does **not** transparently encrypt heap files, indexes, WAL, temp files, or logs at rest. The pgcrypto extension encrypts only the specific cells your SQL hands it. For block-level at-rest encryption, you must use one of: (1) operating-system-level encryption (LUKS, dm-crypt, ZFS native, BitLocker), (2) a third-party distribution that ships a TDE patch (Percona `pg_tde`[^pg-tde], EDB's TDE in EDB Postgres Advanced Server[^edb-tde], Cybertec PostgreSQL Transparent Data Encryption — verify their current product status yourself), or (3) a hardware-encrypted storage layer. Operators who think `pgcrypto` provides TDE are confusing column-level cryptography with whole-cluster-at-rest encryption.

## Mental Model — Five Rules

1. **pgcrypto encrypts *cells*, not files.** When you call `pgp_sym_encrypt('hello', 'mykey')`, the ciphertext is stored in one `bytea` column. The rest of the row, every index, the WAL, the visibility map, the freespace map, and the relation file are stored unencrypted. Anyone with read access to `$PGDATA` can read everything that isn't inside a pgcrypto-encrypted column. **At-rest protection requires LUKS / ZFS native / a third-party TDE patch.**

2. **pgcrypto requires OpenSSL.** The verbatim build requirement from the docs: *"`pgcrypto` requires OpenSSL and won't be installed if OpenSSL support was not selected when PostgreSQL was built."*[^pgcrypto-main] PG15 release notes explicitly enforced this: *"Require OpenSSL to build the pgcrypto extension (Peter Eisentraut)."*[^pg15-ssl] **There is no built-in fallback** — packages without OpenSSL support do not ship pgcrypto.

3. **The key always travels through the SQL layer.** Verbatim from the docs: *"All `pgcrypto` functions run inside the database server. That means that all the data and passwords move between `pgcrypto` and client applications in clear text. Thus you must: 1. Connect locally or use SSL connections. 2. Trust both system and database administrator. If you cannot, then better do crypto inside client application."*[^pgcrypto-security] **The server sees the key, the plaintext, and the ciphertext all simultaneously**. This is the structural reason why pgcrypto cannot solve "encrypt so the DBA cannot read it" — the DBA can read the running query, server log, or memory dump.

4. **`crypt()` is for password verification, not encryption.** `crypt(password, salt)` produces a one-way hash designed to *verify* a presented password against a stored one. It is not reversible. `gen_salt('bf', 8)` produces a bcrypt salt with cost factor 8. **Use `crypt()` + `gen_salt('bf', 12)` for application password storage; do not use it for encrypting reversible data.** For reversible encryption use `pgp_sym_encrypt` (PGP envelope) or `encrypt` (raw block cipher).

5. **`gen_random_uuid()` is no longer a pgcrypto function on PG13+.** It was promoted into core in PG13: verbatim *"Add function `gen_random_uuid()` to generate version-4 UUIDs (Peter Eisentraut). Previously UUID generation functions were only available in the external modules `uuid-ossp` and `pgcrypto`."*[^pg13-uuid] On PG14+ you do not need pgcrypto installed to generate UUIDs. Cross-reference [`18-uuid-numeric-money.md`](./18-uuid-numeric-money.md).

## Decision Matrix

| You need to | Use | Avoid | Why |
|---|---|---|---|
| Encrypt heap, WAL, temp files at rest | LUKS / ZFS / dm-crypt / third-party TDE patch | pgcrypto (cell-only) | pgcrypto can't reach the storage layer |
| Encrypt one column's value reversibly | `pgp_sym_encrypt(plain, key)` returning `bytea` | hand-rolled AES via `encrypt()` | PGP envelope gives auth-tag (MDC), versioned format, sane defaults |
| Encrypt with public/private key pair | `pgp_pub_encrypt(plain, pubkey_bytea)` | self-managed RSA | PGP envelope handles session-key wrap, format, MDC |
| Hash a password for login verification | `crypt(input, stored_hash) = stored_hash` with `gen_salt('bf', 12)` at insert | `digest()` / `md5()` | `crypt()` is adaptive (cost factor), salted, side-channel-aware |
| Compute a content hash for dedup / fingerprint | `digest(data, 'sha256')` | `md5()` (collision-prone) | SHA-256 is cryptographically current; MD5/SHA-1 are not |
| Sign a payload for integrity | `hmac(data, secret, 'sha256')` | naked `digest()` | HMAC requires the secret — prevents length-extension attacks |
| Generate cryptographic random bytes | `gen_random_bytes(32)` | `random()` from core | core `random()` is *not* cryptographically secure |
| Generate a UUID (PG13+) | core `gen_random_uuid()` | pgcrypto (legacy) | UUID generation moved into core on PG13 |
| Encrypt key never visible to PG | application-side encryption (encrypt before INSERT) | pgcrypto | pgcrypto requires keys in SQL — they leak into logs and `pg_stat_activity` |
| Disable built-in crypto under FIPS | PG18 `pgcrypto.builtin_crypto_enabled = 'fips'` | hand-blocking | PG18+ formalizes FIPS-mode gating[^pg18-builtin] |
| Hash passwords with sha256crypt/sha512crypt | PG18 `gen_salt('sha256crypt', N)` or `gen_salt('sha512crypt', N)` | sticking with bcrypt | PG18 added these as adaptive alternatives[^pg18-shacrypt] |
| Detect FIPS mode in SQL | PG18 `fips_mode()` | guessing from server config | PG18 added the introspection function[^pg18-fips] |

**Three smell signals** that you have reached for the wrong tool:

- **You are writing the key as a SQL literal in your application code.** That key appears in `pg_stat_statements`, in the server log if `log_statement = 'all'` or `log_min_duration_statement = 0`, and in `pg_stat_activity.query`. Use a parameter binding (`$1`) so the key text never enters the parsed query string, and ensure the bound value still doesn't reach logs — better, encrypt application-side.
- **You are using `pgcrypto` because the compliance auditor said "encrypt at rest."** Cell-level encryption rarely satisfies "encrypt at rest" because the index over the encrypted column, the WAL, and `pg_dump` output still contain plaintext-related artifacts (column statistics, sometimes the row layout). Whole-cluster TDE or filesystem-level encryption is almost always the right answer.
- **You are using `md5()` from core or `digest(x, 'md5')` for security purposes.** MD5 is broken. PG18 has the explicit warning about MD5 password authentication ([`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) gotcha #13). Use SHA-256 or BLAKE2 via OpenSSL.

## Installing pgcrypto

```sql
CREATE EXTENSION pgcrypto;            -- trusted since PG13, non-superuser CREATE on database is enough
CREATE EXTENSION pgcrypto WITH SCHEMA app_crypto;  -- isolate from public for SECURITY DEFINER hardening
```

Verbatim from the docs: *"This module is considered 'trusted', that is, it can be installed by non-superusers who have CREATE privilege on the current database."*[^pgcrypto-main]

Verify installation and version:

```sql
SELECT extname, extversion, nspname AS schema
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE extname = 'pgcrypto';
```

If the `CREATE EXTENSION` raises `extension "pgcrypto" is not available`, the PostgreSQL package was built without OpenSSL — there is no pgcrypto.so to load. You must either install a PostgreSQL build with OpenSSL support or use a different package source.

## Hash Functions: digest() and hmac()

```sql
digest(data text,  type text) RETURNS bytea
digest(data bytea, type text) RETURNS bytea
hmac(data text,  key text,  type text) RETURNS bytea
hmac(data bytea, key bytea, type text) RETURNS bytea
```

Verbatim from the docs: *"Standard algorithms are `md5`, `sha1`, `sha224`, `sha256`, `sha384` and `sha512`. Moreover, any digest algorithm OpenSSL supports is automatically picked up."*[^pgcrypto-hash] In practice this means BLAKE2 variants and SHA3 are usually available when your OpenSSL is recent enough — verify with `digest('x', 'blake2b256')` against your actual server.

| Function | Use when | Don't use when |
|---|---|---|
| `digest(data, 'sha256')` | Content fingerprint, deduplication, cache key | You need integrity protection against forgery (use `hmac`) |
| `digest(data, 'sha512')` | Same but wider output | Storage cost matters and SHA-256 already suffices |
| `digest(data, 'md5')` | Compatibility with legacy systems | Security purpose (collisions are practical) |
| `hmac(data, key, 'sha256')` | Signed payload, webhook validation, integrity protection | Asymmetric verification (you'd need PGP signing) |
| `hmac(data, key, 'sha512')` | Same with wider output | — |

`hmac()` is the right answer for "I have a server secret and I want to detect tampering of a payload." The recipient verifies by recomputing the HMAC with the same key and comparing constant-time. **Plain `digest(secret || data, 'sha256')` is vulnerable to length-extension attacks on SHA-2.** Always use `hmac()`, never roll your own.

```sql
-- Webhook payload signing
SELECT encode(hmac('{"event":"order.placed","id":42}', 'shared-secret', 'sha256'), 'hex');
-- 1a2b3c... — send this in X-Signature header, recipient recomputes and compares constant-time
```

## Password Hashing: crypt() and gen_salt()

```sql
crypt(password text, salt text) RETURNS text
gen_salt(type text [, iter_count integer]) RETURNS text
```

The `crypt()` function takes a password and a *previously-generated* salt (or a stored hash, which contains the salt as a prefix), and returns a hash. To **store** a new password, generate a salt with `gen_salt()`; to **verify**, call `crypt(presented_password, stored_hash) = stored_hash`.

**Salt algorithms (Table F.18 in PG16 docs[^pgcrypto-crypt]):**

| Algorithm | Max password length | Adaptive cost? | Salt bits | Output length | Description |
|---|---|---|---|---|---|
| `bf` | 72 | yes (4–31) | 128 | 60 | Blowfish-based (bcrypt variant 2a) |
| `md5` | unlimited | no | 48 | 34 | MD5-based crypt (do not use for new systems) |
| `xdes` | 8 | yes (1–16777215, odd only) | 24 | 20 | Extended DES |
| `des` | 8 | no | 12 | 13 | Original UNIX crypt (do not use) |
| `sha256crypt` *(PG18+)* | unlimited | yes | up to 32 | 80 | Adapted from public reference SHA-256/SHA-512 Unix crypt[^pg18-shacrypt] |
| `sha512crypt` *(PG18+)* | unlimited | yes | up to 32 | 123 | Adapted from public reference SHA-256/SHA-512 Unix crypt[^pg18-shacrypt] |

> [!NOTE] PostgreSQL 18
> Added `sha256crypt` and `sha512crypt` as `gen_salt()` algorithms: verbatim *"Add pgcrypto algorithms `sha256crypt` and `sha512crypt` (Bernd Helmle)."*[^pg18-shacrypt] These are useful for compatibility with Linux `/etc/shadow` `$5$` / `$6$` hash formats. For new application password storage, `bf` with cost 12 (bcrypt) remains a defensible default. The verbatim password-length-72 limit of bcrypt is the operational reason some teams move to `sha512crypt` — bcrypt silently truncates passwords longer than 72 bytes.

```sql
-- Insert: hash the password with bcrypt cost 12
INSERT INTO users (email, password_hash)
VALUES ('alice@example.com', crypt('alice-plaintext-pw', gen_salt('bf', 12)));

-- Verify: recompute with the stored salt (embedded in the hash) and compare
SELECT id
FROM users
WHERE email = 'alice@example.com'
  AND password_hash = crypt('presented-password', password_hash);
```

The verbatim iteration-count ranges (Table F.19): `bf` default 6, min 4, max 31; `xdes` default 725, min 1, max 16777215, must be odd.[^pgcrypto-crypt] Default `bf` cost of 6 is too low for modern hardware — pass 12 explicitly: `gen_salt('bf', 12)`.

## Random Bytes: gen_random_bytes()

```sql
gen_random_bytes(count integer) RETURNS bytea
```

Returns `count` cryptographically random bytes. **This is the source you want** for nonces, session tokens, password-reset tokens, salt bytes (when not using `gen_salt()`), IVs.

The built-in `random()` function in PostgreSQL core is **not** cryptographically secure — it produces predictable, period-bounded output suitable for sampling and Monte Carlo but not for security.

```sql
-- Cryptographically random 32-byte token
SELECT encode(gen_random_bytes(32), 'hex');     -- 64-char hex string
SELECT encode(gen_random_bytes(16), 'base64');  -- 24-char base64 (URL-unsafe by default)
```

## Raw Symmetric Encryption: encrypt() / decrypt()

```sql
encrypt(data    bytea, key bytea,                type text) RETURNS bytea
decrypt(data    bytea, key bytea,                type text) RETURNS bytea
encrypt_iv(data bytea, key bytea, iv bytea, type text) RETURNS bytea
decrypt_iv(data bytea, key bytea, iv bytea, type text) RETURNS bytea
```

The `type` argument is a string like `aes-cbc/pad:pkcs` specifying algorithm, mode, and padding. Verbatim grammar: `algorithm [ -mode ] [ /pad:padding ]`.[^pgcrypto-raw]

| Choice | Values | Default | Notes |
|---|---|---|---|
| Algorithm | `bf`, `aes` | none | `aes` is AES-128/192/256 depending on key length (16/24/32 bytes); `bf` is Blowfish (legacy) |
| Mode | `cbc`, `ecb`, `cfb` *(PG18+)*[^pg18-cfb] | `cbc` | ECB is *for testing only* per docs verbatim |
| Padding | `pkcs`, `none` | `pkcs` | `none` requires data length to be a multiple of the block size |

> [!WARNING] Raw `encrypt()` does not authenticate
> Raw `encrypt()` is unauthenticated. A bit-flip attack on the ciphertext is invisible — `decrypt()` returns garbage rather than raising an error. **Prefer `pgp_sym_encrypt`**, which includes a Modification Detection Code (MDC) that detects tampering. Use raw `encrypt()` only when you need exact wire-compatibility with an external system that already speaks `aes-cbc`.

```sql
-- AES-256-CBC with explicit IV (DO NOT use encrypt() without _iv variant — predictable IV is weak)
WITH params AS (
    SELECT
        '\xfeedface0123456789abcdef0123456789abcdef0123456789abcdef01234567'::bytea AS key,  -- 32 bytes for AES-256
        gen_random_bytes(16) AS iv                                                            -- fresh IV per message
)
SELECT
    encode(iv, 'hex')                                                            AS iv_hex,
    encode(encrypt_iv('secret payload', key, iv, 'aes-cbc/pad:pkcs'), 'hex')    AS ciphertext_hex
FROM params;
```

**Critical:** Reusing an IV across multiple encryptions with the same key in CBC mode leaks information. Always generate a fresh IV via `gen_random_bytes(16)` for AES.

## PGP Symmetric Encryption: pgp_sym_encrypt() / pgp_sym_decrypt()

```sql
pgp_sym_encrypt      (data text,  psw text [, options text]) RETURNS bytea
pgp_sym_encrypt_bytea(data bytea, psw text [, options text]) RETURNS bytea
pgp_sym_decrypt      (msg bytea,  psw text [, options text]) RETURNS text
pgp_sym_decrypt_bytea(msg bytea,  psw text [, options text]) RETURNS bytea
```

These wrap your data in an OpenPGP-format message authenticated with a password-derived key. **This is the default symmetric primitive to reach for** — it handles IV generation, key derivation (`s2k`), MDC for tamper-detection, and compression automatically.

**Default options[^pgcrypto-pgp]:**

| Option | Values | Default | Use case |
|---|---|---|---|
| `cipher-algo` | `bf, aes128, aes192, aes256, 3des, cast5` | `aes128` | Set `aes256` for stronger key |
| `compress-algo` | `0, 1, 2` | `0` (off) | Set `2` (ZLIB) if data is compressible |
| `compress-level` | `0–9` | `6` | Trade CPU for size |
| `convert-crlf` | `0, 1` | `0` | Set `1` for text-mode CRLF normalization |
| `disable-mdc` | `0, 1` | `0` | **Leave at 0 — MDC is the tamper detection** |
| `sess-key` | `0, 1` | `0` (sym only) | `1` generates a separate session key |
| `s2k-mode` | `0, 1, 3` | `3` | Variable-iteration salted s2k (the strong setting) |
| `s2k-count` | (computed) | random 65536–253952 | Iteration count for s2k |
| `s2k-digest-algo` | `md5, sha1` | `sha1` | The s2k hash (OpenPGP-spec-bound) |
| `s2k-cipher-algo` | `bf, aes, aes128, aes192, aes256` | "use `cipher-algo`" | — |
| `unicode-mode` | `0, 1` | `0` | — |

Verbatim from the docs on `s2k-mode`: *"`0 — Without salt. Dangerous!` / `1 — With salt but with fixed iteration count.` / `3 — Variable iteration count.`"*[^pgcrypto-pgp]

```sql
-- Default: AES-128, MDC on, s2k-mode 3 — all sensible
INSERT INTO secrets (name, payload)
VALUES ('api_key', pgp_sym_encrypt('sk-abc123...', current_setting('app.master_key')));

-- AES-256 with compression enabled (for larger or compressible payloads)
SELECT pgp_sym_encrypt(
    'long document...',
    'pass',
    'cipher-algo=aes256, compress-algo=2, compress-level=6'
);

-- Decrypt — returns text (or NULL if password wrong / data corrupt / MDC fails)
SELECT pgp_sym_decrypt(payload, current_setting('app.master_key'))
FROM secrets WHERE name = 'api_key';
```

If decryption fails (wrong password, tampered ciphertext, MDC mismatch), `pgp_sym_decrypt` raises an error — it does not silently return NULL or garbage. Wrap in `EXCEPTION WHEN OTHERS` only if you genuinely want to swallow the error class (rarely correct).

## PGP Asymmetric Encryption: pgp_pub_encrypt() / pgp_pub_decrypt()

```sql
pgp_pub_encrypt      (data text,  key bytea [, options text]) RETURNS bytea
pgp_pub_encrypt_bytea(data bytea, key bytea [, options text]) RETURNS bytea
pgp_pub_decrypt      (msg bytea,  key bytea [, psw text [, options text]]) RETURNS text
pgp_pub_decrypt_bytea(msg bytea,  key bytea [, psw text [, options text]]) RETURNS bytea
pgp_key_id(bytea) RETURNS text
```

Encrypts to a recipient's public key (anyone with the public key can encrypt; only the private-key holder can decrypt). Use when the encryption-side and decryption-side identities are different — typically a producer (encrypts with public key, can never read back) and a consumer (decrypts with private key).

```sql
-- Generate a keypair outside Postgres with GPG:
--   gpg --batch --gen-key keyfile.spec
--   gpg --export       --armor keyholder@example.com > public.asc
--   gpg --export-secret-keys --armor keyholder@example.com > private.asc
--
-- Then load the de-armored bytea forms into Postgres:
SELECT pgp_pub_encrypt(
    'sensitive payload',
    dearmor('-----BEGIN PGP PUBLIC KEY BLOCK-----\n...\n-----END PGP PUBLIC KEY BLOCK-----')
);

-- Decryption with a password-protected private key
SELECT pgp_pub_decrypt(
    ciphertext,
    dearmor(:'private_armored'),
    :'private_key_passphrase'
);
```

**PGP limitations (verbatim from docs)[^pgcrypto-pgp-lim]:**

- *"No support for signing. That also means that it is not checked whether the encryption subkey belongs to the master key."*
- *"No support for encryption key as master key. As such practice is generally discouraged, this should not be a problem."*
- *"No support for several subkeys. This may seem like a problem, as this is common practice. On the other hand, you should not use your regular GPG/PGP keys with `pgcrypto`, but create new ones, as the usage scenario is rather different."*

**Operational consequence:** generate dedicated keypairs for pgcrypto use; do not import production GPG/PGP user keys.

## PGP Armor and Key Inspection

```sql
armor(data bytea [, keys text[], values text[]]) RETURNS text
dearmor(data text) RETURNS bytea
pgp_armor_headers(data text, key OUT text, value OUT text) RETURNS SETOF record
pgp_key_id(bytea) RETURNS text
```

`armor()` wraps binary PGP data in printable ASCII (the `-----BEGIN PGP MESSAGE-----` envelope). `dearmor()` reverses it. `pgp_key_id()` extracts the key ID from a public or private key blob — useful for verifying you loaded the right key.

```sql
-- Identify which key encrypted a message
SELECT pgp_key_id(ciphertext) FROM secrets WHERE id = 42;
```

## PG18 Additions: FIPS, builtin_crypto_enabled, sha256crypt/sha512crypt, CFB

> [!NOTE] PostgreSQL 18
> Four pgcrypto additions in PG18, all from the verbatim E.4.3.9.2 pgcrypto section[^pg18-pgcrypto-block]:
>
> 1. **`sha256crypt` and `sha512crypt` as `gen_salt()` algorithms** — *"Add pgcrypto algorithms `sha256crypt` and `sha512crypt` (Bernd Helmle)."*[^pg18-shacrypt] Useful for unlimited-password-length adaptive hashing where you don't want the bcrypt 72-byte truncation.
> 2. **CFB mode for `encrypt()` / `decrypt()`** — *"Add CFB mode to pgcrypto encryption and decryption (Umar Hayat)."*[^pg18-cfb] Use `aes-cfb` as the type string.
> 3. **`fips_mode()` function** — *"Add function `fips_mode()` to report the server's FIPS mode (Daniel Gustafsson)."*[^pg18-fips] Returns `true` if OpenSSL is running with FIPS enabled. Useful for SQL-level FIPS-readiness checks in compliance audits.
> 4. **`pgcrypto.builtin_crypto_enabled` GUC** — *"Add pgcrypto server variable `builtin_crypto_enabled` to allow disabling builtin non-FIPS mode cryptographic functions (Daniel Gustafsson, Joe Conway). This is useful for guaranteeing FIPS mode behavior."*[^pg18-builtin] Three values: `on` (default, all builtin functions work), `off` (disable `gen_salt()` and `crypt()` outright), `fips` (disable only when OpenSSL is in FIPS mode).

The `builtin_crypto_enabled` GUC formalizes what was previously an implicit split: `gen_salt()` and `crypt()` were implemented inside pgcrypto rather than via OpenSSL, so under FIPS those non-FIPS-validated implementations were a hidden compliance gap. Setting `pgcrypto.builtin_crypto_enabled = 'fips'` makes them unavailable when FIPS mode is active.

```sql
-- PG18+ FIPS check
SELECT fips_mode();   -- t or f

-- Cluster-wide enforcement
ALTER SYSTEM SET pgcrypto.builtin_crypto_enabled = 'fips';
SELECT pg_reload_conf();

-- Under FIPS, password hashing must use OpenSSL-validated SHA-2; bcrypt becomes unavailable
-- because its blowfish primitive is not FIPS-validated. Use sha256crypt/sha512crypt instead:
INSERT INTO users (email, password_hash)
VALUES ('bob@example.com', crypt('plaintext', gen_salt('sha512crypt', 656000)));
```

## Key Management — the Actual Hard Problem

Three key-management patterns and their trade-offs.

### Pattern A — Key as a session GUC (single-tenant app)

```sql
-- App connects, sets the key into the session (only this backend's memory holds it):
SET app.master_key = 'long-random-key-from-secrets-manager';

-- Encrypt / decrypt by reading current_setting:
INSERT INTO secrets (data) VALUES (pgp_sym_encrypt('hello', current_setting('app.master_key')));
SELECT pgp_sym_decrypt(data, current_setting('app.master_key')) FROM secrets;
```

**Pros:** key never written to disk, never appears in `pg_stat_statements` if you used `current_setting()`, naturally cleared on disconnect.

**Cons:** key is visible to the DBA via memory dump or via `current_setting()` in another session if they `SET ROLE`. Connection pooler may reuse backend across users — clear the GUC explicitly on connection-checkout (cross-reference [`81-pgbouncer.md`](./81-pgbouncer.md)).

### Pattern B — Key in a separate secrets store, app decrypts (recommended)

```text
app process               PostgreSQL backend
---------------------     -----------------------
get key from KMS  -->     INSERT INTO secrets
encrypt locally           VALUES (binary_ciphertext)
                          <-- (database never sees the key)
read ciphertext   <--     SELECT data FROM secrets
decrypt locally
```

The application reads the encryption key from a secrets manager (AWS KMS, HashiCorp Vault, GCP KMS, Azure Key Vault, etc.), encrypts before INSERT, decrypts after SELECT. The database stores opaque `bytea`. **The database never sees the key.**

**Pros:** the DBA, the WAL, `pg_dump` output, replication, and read-replicas all see only ciphertext. No pgcrypto needed on the server side.

**Cons:** you cannot do SQL `WHERE column = 'value'` against the encrypted column (it's an opaque blob). Indexing requires deterministic encryption (the same plaintext always produces the same ciphertext) or a separate hash column for equality lookups. **Range queries are impossible.**

### Pattern C — Per-row key derived from a master + row identifier

```sql
-- Master key in a session GUC; per-row key = HMAC(master, row_id)
CREATE FUNCTION row_key(master text, row_id bigint) RETURNS bytea
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT hmac(row_id::text, master::bytea, 'sha256') $$;

INSERT INTO secrets (id, payload)
VALUES (
    nextval('secrets_id_seq'),
    pgp_sym_encrypt('plaintext', encode(row_key(current_setting('app.master_key'), currval('secrets_id_seq')), 'hex'))
);
```

**Pros:** each row encrypted with a unique key; compromise of one ciphertext doesn't reveal anything about other rows; key rotation can rotate just the master.

**Cons:** complexity. Use Pattern A or B if per-row key derivation is not a hard requirement.

### Hard limitations regardless of pattern

- **The server can always read the plaintext while a query is running.** `log_statement = 'all'`, `auto_explain.log_min_duration`, or a misconfigured `pg_stat_statements` capture can put keys or plaintexts in your logs.
- **WAL contains the post-encrypted bytea, not the key, but it does contain the unencrypted column data for any non-encrypted columns in the same row.** TOAST chunks for encrypted blobs are not themselves protected at rest.
- **Backups (`pg_dump`, `pg_basebackup`) contain encrypted columns as ciphertext, but everything else as plaintext.** Encrypt the backup at the storage layer ([`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md), [`85-backup-tools.md`](./85-backup-tools.md)).

## The In-Core TDE Gap and Third-Party Landscape

PostgreSQL community decided long ago not to ship in-core TDE. The reasoning is documented in mailing-list threads on `pgsql-hackers`: TDE has limited security benefit against the threat model where the DBA is trusted (encryption keys must be available to the running server, so the DBA can always read them); against the threat model where the DBA is untrusted, TDE alone is insufficient (the DBA can capture queries, plaintext-in-memory, and logs anyway). The community position is **filesystem encryption is the right layer** for at-rest protection of heap, indexes, and WAL.

### Filesystem and block-level encryption (the standard answer)

| Mechanism | Layer | Notes |
|---|---|---|
| LUKS / dm-crypt | block device | Linux standard; key in TPM or kernel keyring; transparent to PG |
| ZFS native encryption | filesystem | ZFS-on-Linux; native AES-256-GCM; per-dataset keys |
| eCryptfs / fscrypt | filesystem | Per-file/per-directory keys |
| BitLocker | block device | Windows equivalent of LUKS |
| Hardware self-encrypting drives | block | Transparent at OS layer; key management is hardware-managed |
| Cloud-volume encryption | block | Provider-managed disk encryption (covered categorically; not endorsing any specific provider — see [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md)) |

These are **the recommended approach** for whole-cluster at-rest encryption. They cover heap files, indexes, WAL, temp files, server logs, and anything else in `$PGDATA`.

### Third-party TDE distributions

Distributions that ship a TDE patch (verify their current product status — vendor product names and availability change):

- **Percona pg_tde** (Percona Server for PostgreSQL 17 / 18): GitHub https://github.com/percona/pg_tde[^pg-tde] provides a `tde_heap` table access method that encrypts heap pages, indexes, and WAL with AES at write time. Supports file-based and external KMS providers (HashiCorp Vault, KMIP). This is an **opt-in per-table** TDE: you create tables with `USING tde_heap` to encrypt them, while the rest of the cluster remains plain heap. Active development, open source.
- **EDB Postgres Advanced Server TDE**: included with EDB's commercial distribution[^edb-tde]. Encrypts data files and WAL; integrated with various enterprise key-management systems. Closed-source / commercial license.
- **Cybertec PostgreSQL Transparent Data Encryption**: a TDE patch sold by Cybertec. (Product status — verify directly with the vendor before relying.)

> [!WARNING] Third-party TDE patches are not the same as vanilla PostgreSQL
> Each of the above is a distribution-specific fork or extension. Your application code is portable, but operational tooling (`pg_basebackup`, `pg_upgrade`, replication) may behave differently or require version-locked compatible tools. Test your full disaster-recovery workflow against the distribution before committing to it for production.

## Per-Version Timeline

| Version | pgcrypto changes |
|---|---|
| **PG13** | `gen_random_uuid()` promoted from pgcrypto / uuid-ossp into core: verbatim *"Add function `gen_random_uuid()` to generate version-4 UUIDs (Peter Eisentraut). Previously UUID generation functions were only available in the external modules `uuid-ossp` and `pgcrypto`."*[^pg13-uuid] Also pgcrypto became a trusted extension (non-superusers with CREATE privilege can install it). |
| **PG14** | *No pgcrypto-specific release-note items.* |
| **PG15** | OpenSSL becomes a hard build requirement: verbatim *"Require OpenSSL to build the pgcrypto extension (Peter Eisentraut)."*[^pg15-ssl] Packages compiled without `--with-ssl=openssl` no longer build pgcrypto. |
| **PG16** | *No pgcrypto-specific release-note items.* |
| **PG17** | FIPS-mode test compatibility: verbatim *"Allow pgcrypto tests to pass in OpenSSL FIPS mode (Peter Eisentraut)."*[^pg17-fips-tests] Internal change only; no end-user surface. |
| **PG18** | Four additions[^pg18-pgcrypto-block]: `sha256crypt` and `sha512crypt` for `gen_salt()`[^pg18-shacrypt]; CFB mode for `encrypt()` / `decrypt()`[^pg18-cfb]; `fips_mode()` function[^pg18-fips]; `pgcrypto.builtin_crypto_enabled` GUC[^pg18-builtin]. |

## Examples / Recipes

### Recipe 1 — Baseline password storage with bcrypt

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            bigint  GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    email         citext  NOT NULL UNIQUE,
    password_hash text    NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Insert
INSERT INTO users (email, password_hash)
VALUES ('alice@example.com', crypt('alice-pw', gen_salt('bf', 12)));

-- Verify
CREATE OR REPLACE FUNCTION verify_password(p_email citext, p_password text)
RETURNS bigint
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
    SELECT id FROM users
    WHERE email = p_email
      AND password_hash = crypt(p_password, password_hash);
$$;

SELECT verify_password('alice@example.com', 'alice-pw');  -- returns id on success, NULL on failure
```

Cost factor 12 (bcrypt) is a defensible 2025 default on commodity hardware (~250ms per hash on a modern x86 core). Tune higher when your auth path can tolerate slower login.

### Recipe 2 — Password rehash on login when cost is upgraded

```sql
-- When you change policy from cost=10 to cost=12, rehash on next successful login:
CREATE OR REPLACE FUNCTION login_and_maybe_rehash(p_email citext, p_password text, p_target_cost int DEFAULT 12)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_user_id bigint;
    v_current_hash text;
BEGIN
    SELECT id, password_hash INTO v_user_id, v_current_hash
    FROM users
    WHERE email = p_email
      AND password_hash = crypt(p_password, password_hash);

    IF v_user_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- bcrypt hash format: $2a$<cost>$<salt22><hash31> — extract cost
    IF substring(v_current_hash from '\$2.\$(\d+)\$')::int < p_target_cost THEN
        UPDATE users SET password_hash = crypt(p_password, gen_salt('bf', p_target_cost))
        WHERE id = v_user_id;
    END IF;

    RETURN v_user_id;
END;
$$;
```

The hash itself encodes the cost factor — you can detect stale-cost hashes without a separate column.

### Recipe 3 — Reversible cell-level encryption with PGP

```sql
CREATE TABLE customer_pii (
    customer_id bigint PRIMARY KEY,
    ssn_encrypted bytea NOT NULL,  -- pgp_sym_encrypt output
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Encryption goes through a SECURITY DEFINER wrapper so the master key is set per-session
CREATE OR REPLACE FUNCTION store_ssn(p_customer_id bigint, p_ssn text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    INSERT INTO customer_pii (customer_id, ssn_encrypted)
    VALUES (p_customer_id, pgp_sym_encrypt(p_ssn, current_setting('app.pii_key')))
    ON CONFLICT (customer_id) DO UPDATE
    SET ssn_encrypted = EXCLUDED.ssn_encrypted;
$$;

CREATE OR REPLACE FUNCTION read_ssn(p_customer_id bigint)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT pgp_sym_decrypt(ssn_encrypted, current_setting('app.pii_key'))
    FROM customer_pii WHERE customer_id = p_customer_id;
$$;

-- Caller flow
SET app.pii_key = 'master-key-fetched-from-secrets-manager';
SELECT store_ssn(42, '123-45-6789');
SELECT read_ssn(42);
```

Use `SECURITY DEFINER` plus a pinned `search_path` to prevent privilege-escalation via `search_path` injection ([`06-functions.md`](./06-functions.md) gotcha #2).

### Recipe 4 — Application-side encryption (key never enters Postgres)

```python
# Python pseudocode — encrypt before INSERT, decrypt after SELECT
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import os, psycopg

key = fetch_key_from_kms()           # 32 bytes
aesgcm = AESGCM(key)
nonce = os.urandom(12)
ciphertext = aesgcm.encrypt(nonce, b'sensitive data', associated_data=None)

with psycopg.connect("...") as conn:
    conn.execute(
        "INSERT INTO secrets (nonce, ciphertext) VALUES (%s, %s)",
        (nonce, ciphertext)
    )
```

The database never sees the plaintext or the key. WAL contains the bytea blob. `pg_dump` output contains the bytea blob. Replicas receive the bytea blob.

### Recipe 5 — Webhook signature with HMAC-SHA-256

```sql
-- Sign outgoing webhook payload
CREATE OR REPLACE FUNCTION sign_webhook(p_body text, p_secret text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
    SELECT 'sha256=' || encode(hmac(p_body, p_secret, 'sha256'), 'hex');
$$;

SELECT sign_webhook('{"event":"order.placed"}', current_setting('app.webhook_secret'));
-- sha256=abc123...
```

The recipient verifies by recomputing the HMAC server-side with the same shared secret.

### Recipe 6 — Content fingerprint for deduplication

```sql
CREATE TABLE uploads (
    id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    content       bytea NOT NULL,
    content_sha256 bytea NOT NULL GENERATED ALWAYS AS (digest(content, 'sha256')) STORED,
    UNIQUE (content_sha256)
);

-- Inserting the same content twice raises unique_violation — application converts to "already exists"
```

The generated column is computed on INSERT/UPDATE and stored, so the UNIQUE index works without re-hashing on every query.

### Recipe 7 — Bytea column encryption migration (online add-column pattern)

```sql
-- Step 1: add the new encrypted column
ALTER TABLE customers ADD COLUMN ssn_encrypted bytea;

-- Step 2: backfill in batches (set a session key first)
SET app.pii_key = 'master-key';

WITH batch AS (
    SELECT customer_id FROM customers
    WHERE ssn IS NOT NULL AND ssn_encrypted IS NULL
    LIMIT 10000
    FOR UPDATE SKIP LOCKED
)
UPDATE customers c
SET ssn_encrypted = pgp_sym_encrypt(c.ssn, current_setting('app.pii_key'))
FROM batch
WHERE c.customer_id = batch.customer_id;

-- Repeat until zero rows updated. Use SKIP LOCKED to allow multiple workers.

-- Step 3: deploy application reading from ssn_encrypted, fall back to ssn on NULL.
-- Step 4: backfill complete — set ssn = NULL (or drop column entirely after confidence period).
ALTER TABLE customers ALTER COLUMN ssn DROP NOT NULL;
UPDATE customers SET ssn = NULL WHERE ssn_encrypted IS NOT NULL;

-- Step 5: drop the plaintext column.
ALTER TABLE customers DROP COLUMN ssn;
```

Cross-references [`26-index-maintenance.md`](./26-index-maintenance.md) for similar online-migration patterns and [`43-locking.md`](./43-locking.md) Recipe 4 for `SKIP LOCKED` worker patterns.

### Recipe 8 — Cryptographically secure token generation

```sql
-- Session tokens, password-reset tokens, API keys
SELECT 'tok_' || encode(gen_random_bytes(32), 'hex');
-- tok_a1b2c3...  (64 hex chars = 256 bits of entropy)

-- URL-safe base64 variant
SELECT 'tok_' || replace(replace(encode(gen_random_bytes(32), 'base64'), '+', '-'), '/', '_');
```

### Recipe 9 — Detect FIPS mode (PG18+) and choose appropriate algorithm

```sql
-- PG18+: choose gen_salt() type based on FIPS mode at runtime
-- pgcrypto has no GUC for this — check fips_mode() and branch in application code or a helper function.
CREATE OR REPLACE FUNCTION pick_salt() RETURNS text LANGUAGE sql AS $$
    SELECT CASE WHEN fips_mode() THEN gen_salt('sha512crypt') ELSE gen_salt('bf') END;
$$;

-- Usage
SELECT crypt('user_password', pick_salt());
```

### Recipe 10 — Hide encryption keys from `pg_stat_statements`

```sql
-- BAD: master key literal in SQL — appears verbatim in pg_stat_statements
SELECT pgp_sym_encrypt('payload', 'my-secret-key');

-- GOOD: pass key as a bind parameter — pg_stat_statements normalizes it to $2
PREPARE encrypt_one(text, text) AS SELECT pgp_sym_encrypt($1, $2);
EXECUTE encrypt_one('payload', 'my-secret-key');

-- BETTER: key in session GUC, never appears in any SQL text
SET app.master_key = 'my-secret-key';
SELECT pgp_sym_encrypt('payload', current_setting('app.master_key'));
```

Verify with `pg_stat_statements` query inspection ([`57-pg-stat-statements.md`](./57-pg-stat-statements.md)).

### Recipe 11 — Block-cipher modes worked example

```sql
-- AES-256-CBC (default mode)
SELECT encode(encrypt_iv('plaintext', '\xfeedface...32bytes...0123'::bytea,
                          gen_random_bytes(16), 'aes-cbc/pad:pkcs'), 'hex');

-- AES-256-CFB (PG18+)
SELECT encode(encrypt_iv('plaintext', '\xfeedface...32bytes...0123'::bytea,
                          gen_random_bytes(16), 'aes-cfb/pad:none'), 'hex');

-- AES-256-ECB — DO NOT USE for production; the docs literally call it test-only
-- "ecb — each block is encrypted separately (for testing only)"
```

### Recipe 12 — Random sampling vs cryptographic randomness

```sql
-- Core random() — fine for sampling, NOT for security tokens
SELECT * FROM events TABLESAMPLE BERNOULLI(1);
SELECT random();

-- gen_random_bytes() — cryptographic randomness for tokens, keys, IVs, salts
SELECT encode(gen_random_bytes(16), 'hex');
```

Treat `random()` as a sampling primitive only. Anything called "secret," "key," "token," or "nonce" must use `gen_random_bytes()`.

### Recipe 13 — Audit which columns are encrypted (catalog query)

```sql
-- Find every bytea column that might be a pgcrypto-encrypted payload
-- (heuristic: bytea + comment or column name pattern)
SELECT n.nspname     AS schema,
       c.relname     AS table,
       a.attname     AS column,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
       obj_description(c.oid, 'pg_class') AS table_comment,
       col_description(c.oid, a.attnum)   AS column_comment
FROM pg_attribute a
JOIN pg_class c     ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.atttypid = 'bytea'::regtype
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (a.attname ILIKE '%encrypted%'
       OR a.attname ILIKE '%cipher%'
       OR col_description(c.oid, a.attnum) ILIKE '%encrypt%')
ORDER BY n.nspname, c.relname, a.attname;
```

Adopt a column-naming convention (`*_encrypted` suffix or column comment containing `encrypted with pgp_sym_encrypt`) so future audits can find encrypted-data columns programmatically.

## Gotchas / Anti-patterns

1. **pgcrypto is not at-rest encryption.** Cell-level encryption leaves heap files, WAL, indexes, temp files, and `pg_dump` output unencrypted for every non-pgcrypto-protected column. For whole-cluster at-rest, use filesystem encryption or a TDE distribution.
2. **Keys passed as SQL literals appear in `pg_stat_statements` and server logs.** Use bind parameters or session GUCs to keep keys out of the query text. With `log_statement = 'all'` or `log_min_duration_statement = 0`, all queries (and their literals) hit the log.
3. **`gen_random_uuid()` is core in PG13+** — you do not need pgcrypto installed for it. Verbatim release note: *"Previously UUID generation functions were only available in the external modules uuid-ossp and pgcrypto."*[^pg13-uuid] Continuing to install pgcrypto solely for UUIDs is an upgrade-stale habit.
4. **Raw `encrypt()` does not authenticate ciphertext.** Bit-flip attacks are not detected; `decrypt()` returns garbage. Use `pgp_sym_encrypt` (built-in MDC) unless you need bit-exact wire compatibility with an external system.
5. **CBC mode requires a fresh IV per encryption.** Reusing an IV with the same key leaks information. Always use `encrypt_iv()` with `gen_random_bytes(16)`, never `encrypt()` (which uses an internal predictable IV).
6. **ECB mode is for testing only.** Verbatim from the docs: *"`ecb` — each block is encrypted separately (for testing only)"*[^pgcrypto-raw]. Identical plaintext blocks produce identical ciphertext blocks under ECB, leaking structure.
7. **bcrypt silently truncates passwords longer than 72 bytes.** Two passwords identical in their first 72 bytes hash to the same value. For passphrase-style inputs that could exceed 72 bytes, use PG18 `sha256crypt`/`sha512crypt`, or pre-hash with SHA-256 before passing to `crypt()`.
8. **Default `gen_salt('bf')` cost is 6 — too low.** Pass an explicit cost: `gen_salt('bf', 12)`. Periodically re-benchmark and raise as hardware speeds increase.
9. **`crypt()` cost factor is not stored separately — it is embedded in the hash.** You can detect stale-cost hashes by parsing the hash format (`$2a$<cost>$...`), but you cannot raise cost in-place; you must rehash on next successful login.
10. **`digest('md5')` and `md5()` are broken.** Both produce MD5; both are collision-vulnerable for cryptographic purposes. Use SHA-256 or BLAKE2.
11. **`digest(secret || data, 'sha256')` is vulnerable to length-extension** on SHA-2 family hashes. Always use `hmac()` for keyed integrity protection.
12. **PGP `disable-mdc=1` removes tamper detection.** Default is `0` (MDC enabled). Setting `disable-mdc=1` produces an unauthenticated ciphertext indistinguishable from raw `encrypt()`. Never set this option.
13. **PGP `s2k-mode=0` is unsalted.** Verbatim docs say `0 — Without salt. Dangerous!`[^pgcrypto-pgp]. The default (`3`) is correct; never override to `0`.
14. **pgcrypto requires OpenSSL** — verbatim *"`pgcrypto` requires OpenSSL and won't be installed if OpenSSL support was not selected when PostgreSQL was built."*[^pgcrypto-main] Slimmed-down PG packages may omit pgcrypto entirely; check `SELECT * FROM pg_available_extensions WHERE name = 'pgcrypto'`.
15. **PG15+ build requires OpenSSL hard.** Verbatim *"Require OpenSSL to build the pgcrypto extension (Peter Eisentraut)."*[^pg15-ssl] Earlier versions had partial pgcrypto without OpenSSL; PG15+ removed the fallback.
16. **OpenSSL 3.0+ requires the legacy provider for older ciphers.** Verbatim docs: *"When compiled against OpenSSL 3.0.0 and later versions, the legacy provider must be activated in the `openssl.cnf` configuration file in order to use older ciphers like DES or Blowfish."*[^pgcrypto-main] If your `crypt('pw', '$2a$...')` suddenly fails after an OpenSSL upgrade, check the legacy provider.
17. **pgcrypto is not side-channel resistant.** Verbatim docs: *"The implementation does not resist side-channel attacks. For example, the time required for a `pgcrypto` decryption function to complete varies among ciphertexts of a given size."*[^pgcrypto-security] For hostile-environment threats, use a dedicated HSM or client-side library with constant-time guarantees.
18. **NULL inputs propagate.** Verbatim docs: *"As is standard in SQL, all functions return NULL, if any of the arguments are NULL. This may create security risks on careless usage."*[^pgcrypto-security-null] `pgp_sym_encrypt(data, NULL)` returns NULL — no error, no encryption, easy to miss in tests with non-NULL fixtures.
19. **PGP key support is restricted.** Verbatim docs limitations[^pgcrypto-pgp-lim]: no signing, no master-key encryption, no subkeys. Do not load your personal GPG keypair into pgcrypto — generate a dedicated PGP keypair specifically for pgcrypto use.
20. **Encrypted columns cannot be indexed for range queries.** `pgp_sym_encrypt()` is non-deterministic (different IVs each call), so even equality lookups fail unless you store a separate deterministic hash column. Range queries (`WHERE encrypted_col < 'x'`) are impossible by design.
21. **Replication replicates ciphertext, not plaintext.** Both physical (streaming) and logical replication carry the encrypted `bytea` column. A standby with the master key can decrypt; one without cannot. This is correct behavior — but plan for key distribution alongside replica provisioning.
22. **`pg_dump` exports ciphertext.** Restoring on a different cluster requires the same master key. If you rotate keys, you must re-encrypt before dumping or store the old key alongside the dump.
23. **The PG18 `pgcrypto.builtin_crypto_enabled` GUC is `on` by default.** Operators expecting FIPS-mode strictness must set it to `'fips'` explicitly. Verbatim release note: *"This is useful for guaranteeing FIPS mode behavior."*[^pg18-builtin] Without the setting, builtin `gen_salt()`/`crypt()` continue to work even when OpenSSL is in FIPS mode, which may violate compliance.

## See Also

- [`46-roles-privileges.md`](./46-roles-privileges.md) — SCRAM password hashing for *login* roles (different from pgcrypto's `crypt()` for application passwords)
- [`47-row-level-security.md`](./47-row-level-security.md) — RLS combines well with encrypted columns to restrict who can even attempt decryption
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — Connection-time authentication, distinct from at-rest cell encryption
- [`49-tls-ssl.md`](./49-tls-ssl.md) — Transport encryption (in-flight); pgcrypto is at-rest (in-database)
- [`51-pgaudit.md`](./51-pgaudit.md) — Audit-log integration; encrypted-column access should be logged
- [`06-functions.md`](./06-functions.md) — `SECURITY DEFINER` mechanics for safe encryption-helper functions
- [`18-uuid-numeric-money.md`](./18-uuid-numeric-money.md) — `gen_random_uuid()` lives in core on PG13+, not pgcrypto
- [`33-wal.md`](./33-wal.md) — WAL contains the encrypted bytea blob but does not encrypt other columns
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) and [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — backups carry ciphertext; key management for restore
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — provider abstractions of cluster-level at-rest encryption
- [`69-extensions.md`](./69-extensions.md) — extension management lifecycle for pgcrypto and TDE-providing distributions
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — key parameters may leak into `pg_stat_statements` query text; see Recipe 10 for mitigation patterns

## Sources

[^pgcrypto-main]: PostgreSQL 16 documentation, F.28. pgcrypto. Verbatim: *"The `pgcrypto` module provides cryptographic functions for PostgreSQL."* *"This module is considered 'trusted', that is, it can be installed by non-superusers who have `CREATE` privilege on the current database."* *"`pgcrypto` requires OpenSSL and won't be installed if OpenSSL support was not selected when PostgreSQL was built."* *"When compiled against OpenSSL 3.0.0 and later versions, the legacy provider must be activated in the `openssl.cnf` configuration file in order to use older ciphers like DES or Blowfish."* https://www.postgresql.org/docs/16/pgcrypto.html
[^pgcrypto-hash]: PostgreSQL 16 documentation, F.28.1.1 Hash Functions. Verbatim: *"Standard algorithms are `md5`, `sha1`, `sha224`, `sha256`, `sha384` and `sha512`. Moreover, any digest algorithm OpenSSL supports is automatically picked up."* https://www.postgresql.org/docs/16/pgcrypto.html
[^pgcrypto-crypt]: PostgreSQL 16 documentation, F.28.3 Password Hashing Functions, Tables F.18 and F.19. Salt-type table (algorithm / max password length / adaptive / salt bits / output / description) and iteration-count table (default / min / max, with `xdes` odd-only). https://www.postgresql.org/docs/16/pgcrypto.html
[^pgcrypto-raw]: PostgreSQL 16 documentation, F.28.4 Raw Encryption Functions. Verbatim type-string grammar `algorithm [-mode] [/pad:padding]`; algorithms `bf` and `aes`; modes `cbc` (default), `ecb` (*"for testing only"*); padding `pkcs` (default) and `none`. https://www.postgresql.org/docs/16/pgcrypto.html
[^pgcrypto-pgp]: PostgreSQL 16 documentation, F.28.5 PGP Encryption Functions, options section (F.28.5.4). Verbatim option tables including `cipher-algo`, `compress-algo`, `compress-level`, `convert-crlf`, `disable-mdc`, `sess-key`, `s2k-mode` (with verbatim *"`0 — Without salt. Dangerous!`"*), `s2k-count`, `s2k-digest-algo`, `s2k-cipher-algo`, `unicode-mode`. https://www.postgresql.org/docs/16/pgcrypto.html
[^pgcrypto-pgp-lim]: PostgreSQL 16 documentation, F.28.5.3 Limitations. Verbatim: *"No support for signing. That also means that it is not checked whether the encryption subkey belongs to the master key."* *"No support for encryption key as master key. As such practice is generally discouraged, this should not be a problem."* *"No support for several subkeys. This may seem like a problem, as this is common practice. On the other hand, you should not use your regular GPG/PGP keys with `pgcrypto`, but create new ones, as the usage scenario is rather different."* https://www.postgresql.org/docs/16/pgcrypto.html
[^pgcrypto-security]: PostgreSQL 16 documentation, F.28.6.3 Security Limitations. Verbatim: *"All `pgcrypto` functions run inside the database server. That means that all the data and passwords move between `pgcrypto` and client applications in clear text. Thus you must: 1. Connect locally or use SSL connections. 2. Trust both system and database administrator. If you cannot, then better do crypto inside client application."* and *"The implementation does not resist side-channel attacks. For example, the time required for a `pgcrypto` decryption function to complete varies among ciphertexts of a given size."* https://www.postgresql.org/docs/16/pgcrypto.html
[^pgcrypto-security-null]: PostgreSQL 16 documentation, F.28.6.2 NULL Handling. Verbatim: *"As is standard in SQL, all functions return NULL, if any of the arguments are NULL. This may create security risks on careless usage."* https://www.postgresql.org/docs/16/pgcrypto.html
[^pg13-uuid]: PostgreSQL 13.0 release notes, E.24.3.5 Functions. Verbatim: *"Add function `gen_random_uuid()` to generate version-4 UUIDs (Peter Eisentraut). Previously UUID generation functions were only available in the external modules `uuid-ossp` and `pgcrypto`."* https://www.postgresql.org/docs/release/13.0/
[^pg15-ssl]: PostgreSQL 15.0 release notes, E.18.3.11 Source Code. Verbatim: *"Require OpenSSL to build the pgcrypto extension (Peter Eisentraut)."* https://www.postgresql.org/docs/release/15.0/
[^pg17-fips-tests]: PostgreSQL 17.0 release notes, E.10.3.11 Additional Modules. Verbatim: *"Allow pgcrypto tests to pass in OpenSSL FIPS mode (Peter Eisentraut)."* https://www.postgresql.org/docs/release/17.0/
[^pg18-pgcrypto-block]: PostgreSQL 18.0 release notes, E.4.3.9.2 pgcrypto. Four entries enumerated below. https://www.postgresql.org/docs/release/18.0/
[^pg18-shacrypt]: PostgreSQL 18.0 release notes, E.4.3.9.2 pgcrypto. Verbatim: *"Add pgcrypto algorithms `sha256crypt` and `sha512crypt` (Bernd Helmle)."* PG18 pgcrypto.html also extends Table F.18 with `sha256crypt` (unlimited password length, adaptive, up to 32 salt bits, 80 output length) and `sha512crypt` (123 output length), described as *"Adapted from publicly available reference implementation Unix crypt using SHA-256 and SHA-512."* https://www.postgresql.org/docs/release/18.0/ and https://www.postgresql.org/docs/18/pgcrypto.html
[^pg18-cfb]: PostgreSQL 18.0 release notes, E.4.3.9.2 pgcrypto. Verbatim: *"Add CFB mode to pgcrypto encryption and decryption (Umar Hayat)."* https://www.postgresql.org/docs/release/18.0/
[^pg18-fips]: PostgreSQL 18.0 release notes, E.4.3.9.2 pgcrypto. Verbatim: *"Add function `fips_mode()` to report the server's FIPS mode (Daniel Gustafsson)."* PG18 pgcrypto.html: *"Returns `true` if OpenSSL is running with FIPS mode enabled, otherwise `false`."* https://www.postgresql.org/docs/release/18.0/ and https://www.postgresql.org/docs/18/pgcrypto.html
[^pg18-builtin]: PostgreSQL 18.0 release notes, E.4.3.9.2 pgcrypto. Verbatim: *"Add pgcrypto server variable `builtin_crypto_enabled` to allow disabling builtin non-FIPS mode cryptographic functions (Daniel Gustafsson, Joe Conway) — This is useful for guaranteeing FIPS mode behavior."* PG18 pgcrypto.html: *"`pgcrypto.builtin_crypto_enabled` determines if the built in crypto functions `gen_salt()`, and `crypt()` are available for use. Setting this to `off` disables these functions. `on` (the default) enables these functions to work normally. `fips` disables these functions if OpenSSL is detected to operate in FIPS mode."* https://www.postgresql.org/docs/release/18.0/ and https://www.postgresql.org/docs/18/pgcrypto.html
[^pg-tde]: Percona pg_tde, Transparent Data Encryption for PostgreSQL. GitHub repository tagline: *"Transparent Data Encryption for PostgreSQL."* Provides `tde_heap` access method encrypting tuples, WAL, and indexes; targets Percona Server for PostgreSQL 17 and 18; supports file-based KMS and external KMS via Global Key Provider interface. https://github.com/percona/pg_tde
[^edb-tde]: EDB Postgres Advanced Server product page mentions TDE as a security feature: *"Keep customer information secure at all layers with Transparent Data Encryption (TDE), supply chain security measures, and hardened container images."* https://www.enterprisedb.com/products/edb-postgres-advanced-server

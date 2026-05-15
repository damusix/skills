# Collations and Character Encoding

Comparison rules + byte representation. Two adjacent concerns commonly conflated. This file covers the locale-provider catalog (libc / icu / builtin), deterministic vs nondeterministic collations, the libc-collation-upgrade silent-index-break trap, encoding choice (UTF-8 always), and per-version changes through PG18.

---

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Locale providers](#locale-providers)
    - [Deterministic vs nondeterministic collations](#deterministic-vs-nondeterministic-collations)
    - [Standard collations](#standard-collations)
    - [Collation version mismatch — the libc-upgrade trap](#collation-version-mismatch--the-libc-upgrade-trap)
    - [Character set encoding](#character-set-encoding)
    - [CREATE COLLATION grammar](#create-collation-grammar)
    - [CREATE DATABASE locale options](#create-database-locale-options)
    - [Catalogs](#catalogs)
- [Per-version timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

---

## When to Use This Reference

Reach for this file when:

- Picking a locale provider for a new cluster (`initdb --locale-provider=libc|icu|builtin`).
- Investigating a `WARNING: collation "..." has version mismatch` log line after an OS upgrade.
- Deciding between case-insensitive UNIQUE via nondeterministic ICU collation vs `citext` vs `LOWER()` expression index.
- Debugging why a text B-tree index returns wrong rows after a glibc update.
- Reading `pg_collation` or `pg_database` after a PG17 upgrade and seeing `colllocale` / `datlocale` columns (renamed from `colliculocale` / `daticulocale`).
- Planning a PG18 upgrade where FTS and pg_trgm indexes need rebuilding because of the new default-provider rule.

> [!WARNING] Headline operational fact
> A glibc upgrade silently changes the sort order of locale-dependent collations. Indexes (especially B-tree on text columns) become corrupt: queries return wrong rows, UNIQUE constraints permit duplicates, ORDER BY produces wrong order. The cluster *does not detect this* without `datcollversion` / `collversion` tracking (PG15+). **Reindex every text-comparing B-tree index after any glibc upgrade on every cluster running libc collations.**[^libc-upgrade]

[^libc-upgrade]: PG16 [collation.html](https://www.postgresql.org/docs/16/collation.html#COLLATION-VERSIONS): *"PostgreSQL records the version of the collation library that was in effect when the collation was created, and warns if the collation is used with a different version. ... Indexes that use the collation in question would then need to be rebuilt."*

---

## Mental Model

Five rules. Each names a misconception.

1. **Collation = comparison + sort order. Encoding = byte representation. Two different concerns.** Encoding decides what bytes can store; collation decides how to compare/sort those bytes. UTF-8 encoding + multiple collations is the normal case (one cluster, one encoding, many collations).

2. **Three locale providers: libc (OS-dependent), icu (cross-platform), builtin (PG17+, PG-managed).** `libc` uses the operating system's C library — sort order depends on glibc version. `icu` uses the bundled ICU library — sort order tracks ICU version. `builtin` (PG17+) implements `C` / `C.UTF-8` (and PG18 `PG_UNICODE_FAST`) in PostgreSQL itself — immune to OS or library upgrades.[^providers]

3. **All standard + predefined collations are deterministic. User-defined can be nondeterministic (PG12+, ICU only).** Deterministic: byte-equal compares equal. Nondeterministic: ICU-driven equivalence (case-insensitive, accent-insensitive). Nondeterministic enables case-insensitive UNIQUE but **disables B-tree dedup and most pattern operators** (`LIKE` works only on PG18+).[^nondet-default][^nondet-limits][^pg18-like-nondet]

4. **Collation version mismatch is silent corruption.** When the OS or ICU library updates the collation rules, existing B-tree indexes built under the old rules now disagree with the new rules. Queries return wrong rows, UNIQUE permits duplicates. `pg_database.datcollversion` (PG15+) and `pg_collation.collversion` track the recorded version; mismatch yields a `WARNING`. **The warning does not fix anything — rebuild indexes, then `ALTER COLLATION ... REFRESH VERSION`.**[^refresh-version]

5. **UTF-8 is the only reasonable encoding for new clusters. `SQL_ASCII` is the unsafe default for non-ASCII data.** Encoding is set at `initdb` (cluster-wide template) and `CREATE DATABASE` (per-database). Cannot be changed without dump/restore. UTF-8 supports every text any application will ever need.[^sql_ascii]

[^providers]: PG16 [collation.html#COLLATION-MANAGING-PREDEFINED](https://www.postgresql.org/docs/16/collation.html): *"A collation definition has a provider that specifies which library supplies the locale data. One standard provider name is `libc`, which uses the locales provided by the operating system C library. Another provider is `icu`, which uses the external ICU library."* PG17 [locale.html](https://www.postgresql.org/docs/17/locale.html): *"The `builtin` provider uses built-in operations. Only the `C` and `C.UTF-8` locales are supported for this provider."*
[^nondet-default]: PG16 [collation.html#COLLATION-NONDETERMINISTIC](https://www.postgresql.org/docs/16/collation.html): *"All standard and predefined collations are deterministic, all user-defined collations are deterministic by default."*
[^nondet-limits]: PG16 [collation.html#COLLATION-NONDETERMINISTIC](https://www.postgresql.org/docs/16/collation.html): *"Foremost, their use leads to a performance penalty. Note, in particular, that B-tree cannot use deduplication with indexes that use a nondeterministic collation. Also, certain operations are not possible with nondeterministic collations, such as pattern matching operations."*
[^pg18-like-nondet]: PG18 release notes, [18.0](https://www.postgresql.org/docs/release/18.0/): *"Allow LIKE with nondeterministic collations."*
[^refresh-version]: PG16 [sql-altercollation.html](https://www.postgresql.org/docs/16/sql-altercollation.html): *"When that is done, the collation version can be refreshed using the command `ALTER COLLATION ... REFRESH VERSION`. This will update the system catalog to record the current collation version and will make the warning go away. Note that this does not actually check whether all affected objects have been rebuilt correctly."*
[^sql_ascii]: PG16 [charset.html#MULTIBYTE-CHARSET-SUPPORTED](https://www.postgresql.org/docs/16/multibyte.html): *"In most cases, if you are working with any non-ASCII data, it is unwise to use the `SQL_ASCII` setting because PostgreSQL will be unable to help you by converting or validating non-ASCII characters."*

---

## Decision Matrix

13 rows. Action-oriented `Set / Use` / `Default` / `Production value` / `Avoid` columns.

| Need | Set / Use | Default | Production value | Avoid |
|---|---|---|---|---|
| New cluster, no special locale requirements | `initdb --locale-provider=icu --icu-locale=en-US --encoding=UTF8` | libc (pre-PG16) | `--locale-provider=icu` for stability across OS upgrades | `--locale-provider=libc` on production for new clusters |
| Maximum portability + lowest perf overhead | `initdb --locale-provider=builtin --locale=C.UTF-8` (PG17+) | n/a | `--locale-provider=builtin` if no natural-language sort needed | libc on multi-distro fleet |
| Case-insensitive UNIQUE on email column | `CREATE COLLATION ... (provider=icu, locale='und-u-ks-level2', deterministic=false)` | deterministic | column DEFAULT COLLATE this collation + UNIQUE constraint | `LOWER(email)` expression index + UNIQUE on the expression — slower, less idiomatic |
| Avoid all locale-driven sort surprises | Use `COLLATE "C"` or `COLLATE "ucs_basic"` | database default | `COLLATE "C"` for byte-ordered comparisons | letting database default leak into sort-critical columns |
| Sort by Unicode code point in UTF-8 | `COLLATE "ucs_basic"` | database default | `COLLATE "ucs_basic"` for "naive" Unicode sort | `COLLATE "unicode"` (uses UCA, slower) |
| Sort by Unicode Collation Algorithm | `COLLATE "unicode"` (requires ICU) | n/a | use only when language-aware sort needed | per-row collation choice — slow |
| Diagnose post-glibc-upgrade index corruption | `SELECT datname, datcollversion FROM pg_database;` + `pg_amcheck` | n/a | rebuild indexes, then `ALTER ... REFRESH VERSION` | ignoring the WARNING — it means real corruption risk |
| Detect outdated collation version | `SELECT pg_database_collation_actual_version(oid) FROM pg_database;` | n/a | weekly cron + alert on mismatch | manual one-shot checks |
| FTS / pg_trgm + PG18 upgrade | `REINDEX` every FTS and pg_trgm index | n/a | bundle reindex with the upgrade window | leaving FTS indexes from PG≤17 in place on PG18 |
| Case-insensitive comparison (one query) | `WHERE name = 'foo' COLLATE "case_insensitive"` | deterministic | inline COLLATE clause when ad-hoc | `lower(name) = lower('foo')` — index won't help unless functional |
| Pre-PG17 builtin-locale unavailable | Use `COLLATE "C"` or `COLLATE "POSIX"` | libc default | `C` collation gives byte-order, immune to upgrades | letting libc default pin you to OS-dependent sort |
| Per-column collation override | `column_name text COLLATE "fr-FR-x-icu"` | inherited from database | per-column COLLATE for known-language columns | mixing libc + ICU collations in same query (cast required) |
| Read-only application, eventual stability | Migrate cluster to ICU or builtin via dump/restore | libc | migrate during planned maintenance | hoping no OS upgrade ever ships |

Three smell signals that the wrong collation or locale provider is in use:

- `pg_database.datlocprovider = 'c'` (libc) on a cluster running across heterogeneous OSes → fragile. Plan an ICU migration.
- `WARNING: collation "xxx" has version mismatch` in logs → indexes are already at risk. Stop ignoring it.
- Query result order changed after a routine OS patch → libc collation drift. Reindex.

---

## Syntax / Mechanics

### Locale providers

| Provider | Versions | Locale identifier format | Behavior tied to | Use case |
|---|---|---|---|---|
| `libc` | All | `en_US.UTF-8` (POSIX) | Operating-system C library | Default historically; fragile across OS upgrades |
| `icu` | PG10+ (linked); PG16+ build-by-default | `en-US` (BCP 47) | Bundled ICU library version | Production default since PG16; stable across OS upgrades |
| `builtin` | PG17+ | `C` / `C.UTF-8` (PG18 adds `PG_UNICODE_FAST`) | PostgreSQL itself | Maximum stability; zero external dependency |

**libc provider** — verbatim docs: *"A collation object provided by `libc` maps to a combination of `LC_COLLATE` and `LC_CTYPE` settings, as accepted by the `setlocale()` system library call. ... Also, a `libc` collation is tied to a character set encoding. The same collation name may exist for different encodings."*[^libc-provider]

**icu provider** — verbatim docs: *"A collation object provided by `icu` maps to a named collator provided by the ICU library. ICU does not support separate 'collate' and 'ctype' settings, so they are always the same. Also, ICU collations are independent of the encoding, so there is always only one ICU collation of a given name in a database."*[^icu-provider]

> [!NOTE] PostgreSQL 16
> ICU support is now built by default. The build flag `--with-icu` was removed; the new opt-out flag is `--without-icu`. Most distribution packages ship with ICU enabled. Verbatim: *"Build ICU support by default (Jeff Davis) ... This removes build flag `--with-icu` and adds flag `--without-icu`."*[^pg16-icu-default]

> [!NOTE] PostgreSQL 17
> New `builtin` locale provider added. Verbatim: *"Add support for platform-independent collation provider for `C` and `C.UTF-8` locales (Jeff Davis)."* Supports `C` and `C.UTF-8` only on PG17. The `C.UTF-8` builtin locale gives Unicode-aware ctype operations (`upper`, `lower`, `initcap` work on non-ASCII) with code-point-ordered sort, completely independent of any external library.[^pg17-builtin]

> [!NOTE] PostgreSQL 18
> Builtin locale provider gains `PG_UNICODE_FAST`. Verbatim: *"Add builtin collation provider `PG_UNICODE_FAST` (Jeff Davis)."* From [PG18 locale docs](https://www.postgresql.org/docs/18/locale.html): *"The `PG_UNICODE_FAST` locale is available only when the database encoding is `UTF-8`, and the behavior is based on Unicode. The collation uses the code point values only. The regular expression character classes are based on the 'Standard' semantics, and the case mapping is the 'full' variant."*[^pg18-unicode-fast]

[^libc-provider]: PG16 [collation.html#COLLATION-MANAGING-STANDARD](https://www.postgresql.org/docs/16/collation.html).
[^icu-provider]: PG16 [collation.html#COLLATION-MANAGING-STANDARD](https://www.postgresql.org/docs/16/collation.html).
[^pg16-icu-default]: PG16 release notes [16.0](https://www.postgresql.org/docs/release/16.0/).
[^pg17-builtin]: PG17 release notes; PG17 [locale.html](https://www.postgresql.org/docs/17/locale.html).
[^pg18-unicode-fast]: PG18 release notes [18.0](https://www.postgresql.org/docs/release/18.0/); PG18 [locale.html](https://www.postgresql.org/docs/18/locale.html).

### Deterministic vs nondeterministic collations

**Definitions** — verbatim docs: *"A collation is either deterministic or nondeterministic. A deterministic collation uses deterministic comparisons, which means that it considers strings to be equal only if they consist of the same byte sequence. Nondeterministic comparison may determine strings to be equal even if they consist of different bytes. Typical situations include case-insensitive comparison, accent-insensitive comparison, as well as comparison of strings in different Unicode normal forms."*[^det-def]

**Restrictions** — verbatim docs: *"Nondeterministic collations are only supported with the ICU provider."*[^nondet-icu-only]

> [!NOTE] PostgreSQL 12
> Nondeterministic collations introduced. Verbatim: *"Allow creation of collations that report string equality for strings that are not bit-wise equal (Peter Eisentraut)."* Before PG12, case-insensitive UNIQUE required `LOWER()` expression indexes or the `citext` extension.[^pg12-nondet]

**Operations not supported on nondeterministic collations (pre-PG18):**

- Pattern matching operators (`LIKE`, `ILIKE`, `~`, `~*`, `SIMILAR TO`) — **PG18+ supports `LIKE`** with nondeterministic collations.[^pg18-like-nondet]
- B-tree deduplication (the dedup feature from PG13+) — silently disabled.
- Some functions like `regexp_replace` work but with the underlying byte representation, not collation semantics.

**Worked example — case-insensitive UNIQUE without `LOWER()`:**

    CREATE COLLATION case_insensitive (
        provider = icu,
        locale = 'und-u-ks-level2',
        deterministic = false
    );

    CREATE TABLE users (
        id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email     text COLLATE case_insensitive NOT NULL UNIQUE
    );

    INSERT INTO users (email) VALUES ('alice@example.com');
    INSERT INTO users (email) VALUES ('ALICE@example.com');
    -- ERROR: duplicate key value violates unique constraint "users_email_key"
    -- Even though the byte sequences differ, the collation treats them as equal.

> [!WARNING] PG18 PK/FK collation rule
> PG18 added a restriction: *"Require primary/foreign key relationships to use either deterministic collations or the same nondeterministic collations (Peter Eisentraut)."* If a PK column uses nondeterministic collation `A`, the FK column must use the same nondeterministic collation `A` or a deterministic collation. Mixed-nondeterministic across PK/FK boundary is now forbidden.[^pg18-pkfk]

[^det-def]: PG16 [collation.html#COLLATION-NONDETERMINISTIC](https://www.postgresql.org/docs/16/collation.html).
[^nondet-icu-only]: PG16 [sql-createcollation.html](https://www.postgresql.org/docs/16/sql-createcollation.html).
[^pg12-nondet]: PG12 release notes.
[^pg18-pkfk]: PG18 release notes [18.0](https://www.postgresql.org/docs/release/18.0/).

### Standard collations

Five collations are guaranteed present in every cluster.

| Collation | Provider | Available with | Sort behavior | Use case |
|---|---|---|---|---|
| `"default"` | matches cluster | always | inherits database default | almost always implicit |
| `"C"` | libc | always | strict byte order; ASCII rules for letters | fast, predictable, immune to OS upgrades |
| `"POSIX"` | libc | always | same as `C` | legacy synonym for `C` |
| `"ucs_basic"` | libc | UTF8 only | sorts by Unicode code point | "naive" Unicode sort without UCA complexity |
| `"unicode"` | icu | requires ICU | Unicode Collation Algorithm + DUCET | language-agnostic Unicode-correct sort |

**C / POSIX behavior** — verbatim docs: *"The `C` and `POSIX` collations both specify 'traditional C' behavior, in which only the ASCII letters 'A' through 'Z' are treated as letters, and sorting is done strictly by character code byte values."*[^c-posix]

**ucs_basic** — verbatim docs: *"This collation sorts by Unicode code point. It is only available for encoding `UTF8`."*[^ucs-basic]

**unicode** — verbatim docs: *"This collation sorts using the Unicode Collation Algorithm with the Default Unicode Collation Element Table. It is available in all encodings. ICU support is required to use this collation."*[^unicode-coll]

> [!NOTE] PostgreSQL 18
> `pg_unicode_fast` collation added (paired with `PG_UNICODE_FAST` locale). Verbatim: *"This collation sorts by Unicode code point values rather than natural language order. For the functions `lower`, `initcap`, and `upper` it uses Unicode full case mapping."*[^pg18-fast-coll]

[^c-posix]: PG16 [collation.html](https://www.postgresql.org/docs/16/collation.html).
[^ucs-basic]: PG16 [collation.html](https://www.postgresql.org/docs/16/collation.html).
[^unicode-coll]: PG16 [collation.html](https://www.postgresql.org/docs/16/collation.html).
[^pg18-fast-coll]: PG18 [collation.html](https://www.postgresql.org/docs/18/collation.html).

### Collation version mismatch — the libc-upgrade trap

**The headline operational problem.** A glibc upgrade — security patch, distribution upgrade, container base-image bump — silently changes how locale-dependent collations compare strings. Indexes built under the old rules disagree with the new rules. Queries return wrong rows. UNIQUE permits duplicates. `ORDER BY` produces wrong order.

**PG15 added version tracking on `pg_database`.** Verbatim: *"`datcollversion text` — Provider-specific version of the collation. This is recorded when the database is created and then checked when it is used, to detect changes in the collation definition that could lead to data corruption."*[^pg15-datcollversion]

**The exact WARNING text** (PG15+):

    WARNING:  collation "xx-x-icu" has version mismatch
    DETAIL:  The collation in the database was created using version 1.2.3.4,
             but the operating system provides version 2.3.4.5.
    HINT:    Rebuild all objects affected by this collation and run
             ALTER COLLATION pg_catalog."xx-x-icu" REFRESH VERSION,
             or build PostgreSQL with the right library version.

Identical pattern for `pg_collation.collversion` — the WARNING fires the first time the collation is used in a session after the OS upgrade.

**Recovery procedure (in order):**

1. Identify every text-comparing B-tree index using the affected collation.
2. Drop or `REINDEX CONCURRENTLY` each one. ICU collations: usually just text/varchar indexes. libc `C` collation: immune (byte-only).
3. Verify with `pg_amcheck` (PG14+) — runs sanity checks against B-tree indexes, surfaces collation-driven corruption.
4. `ALTER COLLATION "xxx" REFRESH VERSION;` to clear the WARNING.
5. `ALTER DATABASE dbname REFRESH COLLATION VERSION;` (PG15+) to clear the per-database warning.

> [!WARNING] REFRESH VERSION does not validate indexes
> Verbatim docs: *"Note that this does not actually check whether all affected objects have been rebuilt correctly."* Running `REFRESH VERSION` without reindexing first silences the WARNING but leaves the corruption in place. **Reindex first, refresh second, never the reverse.**[^refresh-no-check]

> [!NOTE] PostgreSQL 15
> `ALTER DATABASE ... REFRESH COLLATION VERSION` introduced. Verbatim: *"Update the database collation version."*[^pg15-alter-db-refresh]

**Functions for monitoring collation versions:**

| Function | Returns | Use case |
|---|---|---|
| `pg_collation_actual_version(oid)` | text | Current OS/ICU version for a collation OID |
| `pg_database_collation_actual_version(oid)` | text (PG15+) | Current OS/ICU version for the database default |

Weekly cron pattern (cross-reference [`98-pg-cron.md`](./98-pg-cron.md)):

    SELECT
        datname,
        datcollversion AS recorded_version,
        pg_database_collation_actual_version(oid) AS current_version
    FROM pg_database
    WHERE datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid);

Empty result = healthy. Any rows = reindex required.

[^pg15-datcollversion]: PG15 [catalog-pg-database.html](https://www.postgresql.org/docs/15/catalog-pg-database.html).
[^refresh-no-check]: PG16 [sql-altercollation.html](https://www.postgresql.org/docs/16/sql-altercollation.html).
[^pg15-alter-db-refresh]: PG15 [sql-alterdatabase.html](https://www.postgresql.org/docs/15/sql-alterdatabase.html).

### Character set encoding

**Encoding** = bytes-on-disk representation of a code point. Set at `initdb` (cluster-wide template default) and `CREATE DATABASE` (per-database override). **Cannot be changed for an existing database** — dump + create new database + restore.

| Encoding | Code points | Multi-byte | When to use |
|---|---|---|---|
| `UTF8` | All Unicode | Yes (1-4 bytes per char) | **Default for all new clusters** |
| `LATIN1` (ISO 8859-1) | Western European | No (1 byte per char) | Legacy migrations only |
| `WIN1252` | Windows-1252 | No | Legacy Windows-origin data |
| `SQL_ASCII` | "no encoding declared" | (raw bytes) | **Almost never correct for non-ASCII data** |
| `EUC_JP` / `EUC_CN` / `EUC_KR` / `EUC_TW` | East Asian | Yes | Legacy regional clusters |
| `SHIFT_JIS_2004` | Japanese | Yes | Legacy Japanese clusters |

**Encoding ⟷ locale compatibility** — verbatim docs: *"An important restriction, however, is that each database's character set must be compatible with the database's `LC_CTYPE` (character classification) and `LC_COLLATE` (string sort order) locale settings. For `C` or `POSIX` locale, any character set is allowed, but for other libc-provided locales there is only one character set that will work correctly."*[^encoding-locale-compat]

**ICU is encoding-independent.** ICU collations work with any encoding (UTF-8 in practice). This is one reason ICU is preferred over libc for production: a libc collation like `en_US.UTF-8` only works with UTF-8 encoding, but a libc collation like `en_US.UTF-8` and a libc collation like `en_US.ISO-8859-1` are operationally distinct objects.

**SQL_ASCII trap** — verbatim docs: *"In most cases, if you are working with any non-ASCII data, it is unwise to use the `SQL_ASCII` setting because PostgreSQL will be unable to help you by converting or validating non-ASCII characters."*[^sql-ascii-warn]

`SQL_ASCII` means "the cluster makes no assumption about the bytes." Inserting UTF-8 bytes works, inserting Latin-1 bytes works, but the cluster cannot convert between encodings on read and cannot enforce that input is valid. Result: silent mixed-encoding corruption when a Latin-1-origin app writes to the same column as a UTF-8-origin app.

**`initdb --encoding` and locale interaction (PG16):** *"By default, the template database encoding is derived from the locale. If `--no-locale` is specified (or equivalently, if the locale is `C` or `POSIX`), then the default is `UTF8` for the ICU provider and `SQL_ASCII` for the `libc` provider."*[^initdb-encoding-default]

This means: `initdb --locale-provider=libc --no-locale` gives `SQL_ASCII` as default. Specify `--encoding=UTF8` explicitly to avoid this.

**`normalize()` function** (PG13+) — for Unicode normal forms NFC/NFD/NFKC/NFKD:

    SELECT normalize('Café', NFC);  -- canonical composition
    SELECT normalize('Café', NFD);  -- canonical decomposition

Verbatim: *"This function can only be used when the server encoding is `UTF8`."*[^normalize]

> [!NOTE] PostgreSQL 18 — casefold() function
> Added for "more sophisticated case-insensitive matching." Verbatim definition: *"`casefold(text) → text` — Performs case folding of the input string according to the collation. Case folding is similar to case conversion, but the purpose of case folding is to facilitate case-insensitive matching of strings, whereas the purpose of case conversion is to convert to a particular cased form. This function can only be used when the server encoding is `UTF8`."*[^casefold] Use `casefold(x) = casefold(y)` for Unicode-correct case-insensitive comparison when `LOWER(x) = LOWER(y)` is insufficient (Turkish dotless i, German ß, etc.).

[^encoding-locale-compat]: PG16 [multibyte.html](https://www.postgresql.org/docs/16/multibyte.html).
[^sql-ascii-warn]: PG16 [multibyte.html](https://www.postgresql.org/docs/16/multibyte.html).
[^initdb-encoding-default]: PG16 [app-initdb.html](https://www.postgresql.org/docs/16/app-initdb.html).
[^normalize]: PG16 [functions-string.html](https://www.postgresql.org/docs/16/functions-string.html).
[^casefold]: PG18 release notes [18.0](https://www.postgresql.org/docs/release/18.0/); PG18 [functions-string.html](https://www.postgresql.org/docs/18/functions-string.html).

### CREATE COLLATION grammar

    CREATE COLLATION [IF NOT EXISTS] name (
        [ LOCALE = locale ]
        [, LC_COLLATE = lc_collate ]
        [, LC_CTYPE = lc_ctype ]
        [, PROVIDER = provider ]
        [, DETERMINISTIC = boolean ]
        [, RULES = rules ]      -- PG16+
        [, VERSION = version ]
    )

    CREATE COLLATION [IF NOT EXISTS] name FROM existing_collation

**PROVIDER** — verbatim docs: *"Specifies the provider to use for locale services associated with this collation. Possible values are `icu` (if the server was built with ICU support) or `libc`. `libc` is the default."*[^createcollation-provider]

**DETERMINISTIC** — verbatim docs: *"Specifies whether the collation should use deterministic comparisons. The default is true. A deterministic comparison considers strings that are not byte-wise equal to be unequal even if they are considered logically equal by the comparison. ... Nondeterministic collations are only supported with the ICU provider."*[^createcollation-det]

**LOCALE shortcut** — sets both LC_COLLATE and LC_CTYPE. For ICU collations, supplies the BCP 47 locale name.

**Worked example — German phonebook collation with ICU rules:**

    CREATE COLLATION de_phonebook (
        provider = icu,
        locale = 'de-u-co-phonebk'
    );

    -- Compare ä, ö, ü as ae, oe, ue (phonebook sort) instead of after z
    SELECT 'Müller' < 'Mueller' COLLATE de_phonebook;  -- false in phonebook collation

[^createcollation-provider]: PG16 [sql-createcollation.html](https://www.postgresql.org/docs/16/sql-createcollation.html).
[^createcollation-det]: PG16 [sql-createcollation.html](https://www.postgresql.org/docs/16/sql-createcollation.html).

### CREATE DATABASE locale options

    CREATE DATABASE name [
        OWNER = user
        TEMPLATE = template
        ENCODING = encoding
        STRATEGY = strategy
        LOCALE = locale
        LC_COLLATE = lc_collate
        LC_CTYPE = lc_ctype
        ICU_LOCALE = locale            -- PG15+; renamed in PG17 (see below)
        ICU_RULES = rules              -- PG16+
        LOCALE_PROVIDER = { libc | icu | builtin }
        BUILTIN_LOCALE = locale        -- PG17+
        COLLATION_VERSION = version
        TABLESPACE = tablespace
        ALLOW_CONNECTIONS = bool
        CONNECTION LIMIT = N
        IS_TEMPLATE = bool
        OID = oid
    ]

**LOCALE** — verbatim docs: *"Sets the default collation order and character classification in the new database. ... The default is the same setting as the template database."*[^createdb-locale]

**COLLATION_VERSION** — verbatim docs: *"Specifies the collation version string to store with the database. Normally, this should be omitted, which will cause the version to be computed from the actual version of the database collation as provided by the operating system."*[^createdb-version]

[^createdb-locale]: PG16 [sql-createdatabase.html](https://www.postgresql.org/docs/16/sql-createdatabase.html).
[^createdb-version]: PG16 [sql-createdatabase.html](https://www.postgresql.org/docs/16/sql-createdatabase.html).

### Catalogs

**`pg_collation`** — defines every available collation.

| Column | Type | Notes |
|---|---|---|
| `oid` | oid | row identifier |
| `collname` | name | collation name |
| `collnamespace` | oid | schema OID (usually `pg_catalog` for predefined) |
| `collowner` | oid | role owning the collation |
| `collprovider` | char | `b`=builtin (PG17+), `c`=libc, `i`=icu |
| `collisdeterministic` | bool | PG12+ |
| `collencoding` | int4 | encoding OID this collation is valid for; `-1` = any encoding (ICU, builtin) |
| `collcollate` | text | libc LC_COLLATE; NULL for ICU/builtin |
| `collctype` | text | libc LC_CTYPE; NULL for ICU/builtin |
| `colllocale` | text | PG17+; was `colliculocale` in PG≤16 |
| `collicurules` | text | PG16+; custom ICU rules |
| `collversion` | text | recorded provider version when collation was created |

> [!NOTE] PostgreSQL 17 — column rename
> `pg_collation.colliculocale` was renamed to `pg_collation.colllocale`. Verbatim release-note: *"`pg_collation.colliculocale` → `colllocale`"*. Monitoring queries that read this column under the old name silently break on PG17 upgrade. The column now applies to both ICU and builtin providers.[^pg17-rename]

**`pg_database`** — per-database locale state.

| Column | Type | Notes |
|---|---|---|
| `datlocprovider` | char | PG17+; `b`=builtin, `c`=libc, `i`=icu |
| `datcollate` | text | libc LC_COLLATE for this database |
| `datctype` | text | libc LC_CTYPE for this database |
| `datlocale` | text | PG17+; was `daticulocale` in PG15-16 |
| `daticurules` | text | PG16+; custom ICU rules |
| `datcollversion` | text | PG15+; recorded provider version |
| `encoding` | int4 | database encoding OID (numeric; lookup via `pg_encoding_to_char(encoding)`) |

> [!NOTE] PostgreSQL 17 — column rename
> `pg_database.daticulocale` was renamed to `pg_database.datlocale`. Verbatim release-note: *"`pg_database.daticulocale` → `datlocale`"*. The column now applies to both ICU and builtin providers.[^pg17-rename]

[^pg17-rename]: PG17 release notes; PG17 [catalog-pg-collation.html](https://www.postgresql.org/docs/17/catalog-pg-collation.html) and [catalog-pg-database.html](https://www.postgresql.org/docs/17/catalog-pg-database.html).

---

## Per-version timeline

| Version | Collation/encoding changes |
|---|---|
| PG10 | ICU support added as a build option (`--with-icu`). |
| PG12 | Nondeterministic collations introduced. ICU only.[^pg12-nondet] |
| PG13 | `normalize()` function added (Unicode normal forms). |
| PG14 | **No headline collation/encoding changes** — surface stable. `pg_amcheck` added (PG14+) is the primary tool for detecting collation-driven B-tree corruption after a glibc upgrade. |
| PG15 | `datcollversion` column on `pg_database`. `ALTER DATABASE ... REFRESH COLLATION VERSION`. `pg_database_collation_actual_version()` function.[^pg15-datcollversion][^pg15-alter-db-refresh] |
| PG16 | ICU built by default (`--with-icu` removed; `--without-icu` opt-out). `LOCALE` / `--locale` controls non-libc providers. `ICU_RULES` clause on CREATE COLLATION/DATABASE. `sslrootcert=system` is unrelated. PG16 still defaults `initdb` `--locale-provider` to `libc` — ICU does NOT become the initdb default in PG16, only the build default.[^pg16-icu-default] |
| PG17 | `builtin` locale provider added (`C` and `C.UTF-8` only). Column renames: `colliculocale` → `colllocale`, `daticulocale` → `datlocale`. `datlocprovider` gains `b` for builtin.[^pg17-builtin][^pg17-rename] |
| PG18 | `PG_UNICODE_FAST` builtin collation. `casefold()` function. FTS uses default collation provider (REINDEX FTS + pg_trgm after upgrade — see `73`).  `LIKE` works on nondeterministic collations. PK/FK collation determinism constraint.[^pg18-unicode-fast][^casefold][^pg18-like-nondet][^pg18-pkfk] |

---

## Examples / Recipes

### Recipe 1: New-cluster baseline — ICU + UTF-8

The most common modern configuration. ICU collations are stable across OS upgrades and OS migrations; UTF-8 supports every text.

    # Recommended initdb for new clusters (PG16+):
    initdb \
        --locale-provider=icu \
        --icu-locale=en-US \
        --encoding=UTF8 \
        --data-checksums \
        -D /var/lib/postgresql/16/main

    # Verify after start:
    SELECT
        datname,
        datlocprovider,
        datcollate,
        datctype,
        datlocale,
        pg_encoding_to_char(encoding) AS encoding,
        datcollversion
    FROM pg_database
    WHERE datname = 'postgres';

Expected: `datlocprovider = 'i'`, `encoding = 'UTF8'`, `datlocale = 'en-US'`, `datcollversion` populated.

### Recipe 2: Maximum-stability cluster — builtin + UTF-8 (PG17+)

For clusters that need zero external collation dependency and don't care about natural-language sort order.

    initdb \
        --locale-provider=builtin \
        --locale=C.UTF-8 \
        --encoding=UTF8 \
        --data-checksums \
        -D /var/lib/postgresql/17/main

`C.UTF-8` gives:

- Code-point-ordered sort (stable forever, immune to library upgrades).
- Unicode-aware `upper`/`lower`/`initcap` (works on non-ASCII).
- No ICU runtime dependency.

PG18 alternative: `--locale=PG_UNICODE_FAST` for full Unicode case-mapping.

### Recipe 3: Case-insensitive UNIQUE on email

The canonical use of nondeterministic ICU collation.

    CREATE COLLATION case_insensitive (
        provider = icu,
        locale = 'und-u-ks-level2',
        deterministic = false
    );

    CREATE TABLE users (
        id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email text COLLATE case_insensitive NOT NULL UNIQUE
    );

    INSERT INTO users (email) VALUES ('alice@example.com');
    INSERT INTO users (email) VALUES ('Alice@Example.COM');
    -- ERROR: duplicate key value violates unique constraint

**Alternative without nondeterministic collation** (works on PG≤11 or where ICU isn't available):

    -- Functional UNIQUE index
    CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

    -- Or: citext extension (1-byte type that compares case-insensitively)
    CREATE EXTENSION citext;
    ALTER TABLE users ALTER COLUMN email TYPE citext;

The functional-index approach is more portable but every query must call `lower()` explicitly to use the index. The nondeterministic-collation approach is cleaner because regular `=` works on the column.

### Recipe 4: Detect collation version mismatch — weekly audit

Run as a `pg_cron` job after each scheduled maintenance window.

    SELECT
        datname,
        datcollversion AS recorded_version,
        pg_database_collation_actual_version(oid) AS current_version
    FROM pg_database
    WHERE datallowconn = true
      AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid);

Empty result = healthy. Any rows = OS or ICU library was upgraded since the database was created or last refreshed. Reindex required.

### Recipe 5: Reindex after glibc upgrade — emergency response

Triggered when `WARNING: collation "..." has version mismatch` appears in logs.

    -- 1. Identify text-comparing B-tree indexes (libc collations affected)
    SELECT
        n.nspname || '.' || c.relname AS index_name,
        pg_relation_size(c.oid) AS size_bytes
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am a ON a.oid = c.relam
    WHERE a.amname = 'btree'
      AND EXISTS (
          SELECT 1 FROM pg_attribute att
          JOIN pg_type t ON t.oid = att.atttypid
          WHERE att.attrelid = c.oid
            AND att.attnum > 0
            AND t.typname IN ('text', 'varchar', 'char', 'name')
      )
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY size_bytes DESC;

    -- 2. Reindex each, concurrently if production
    REINDEX INDEX CONCURRENTLY public.users_email_idx;

    -- 3. Verify with amcheck (PG14+)
    SELECT bt_index_check(c.oid, true)
    FROM pg_class c
    WHERE c.relname = 'users_email_idx';

    -- 4. Refresh recorded versions
    ALTER COLLATION pg_catalog."en_US.utf8" REFRESH VERSION;
    ALTER DATABASE app_db REFRESH COLLATION VERSION;

> [!WARNING] Order matters
> Reindex first, refresh second. Refresh silences the WARNING but does not validate any indexes. Refresh-then-reindex risks the corruption persisting between refresh and the next reindex run.

### Recipe 6: Per-column collation override

Different columns can use different collations. Useful when one table holds names from multiple languages.

    CREATE TABLE international_contacts (
        id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name_de text COLLATE "de-DE-x-icu",
        name_fr text COLLATE "fr-FR-x-icu",
        name_ja text COLLATE "ja-JP-x-icu",
        name_en text COLLATE "en-US-x-icu"
    );

    -- ORDER BY uses the column's collation by default
    SELECT name_de FROM international_contacts ORDER BY name_de;

    -- Per-query override
    SELECT name_de FROM international_contacts ORDER BY name_de COLLATE "C";

### Recipe 7: Detect SQL_ASCII clusters

`SQL_ASCII` is almost always a mistake. Audit all clusters.

    SELECT
        datname,
        pg_encoding_to_char(encoding) AS encoding,
        datlocprovider,
        datcollate
    FROM pg_database
    WHERE pg_encoding_to_char(encoding) = 'SQL_ASCII'
      AND datname NOT IN ('template0', 'template1');

Any matches = data-integrity hazard. Plan a dump → recreate with UTF8 → restore.

### Recipe 8: Migrate libc cluster to ICU — dump/restore

A live cluster cannot change its locale provider. Migration path:

    # 1. pg_dumpall from old cluster
    pg_dumpall -h old-host -U postgres > full_dump.sql

    # 2. Initialize new cluster with ICU
    initdb --locale-provider=icu --icu-locale=en-US --encoding=UTF8 -D /new/data

    # 3. Start new cluster, restore
    pg_ctl -D /new/data start
    psql -h new-host -U postgres -f full_dump.sql

    # 4. Verify ICU is active
    psql -c "SELECT datname, datlocprovider FROM pg_database WHERE datname NOT LIKE 'template%';"

> [!NOTE] Logical replication path
> For zero-downtime migration, set up logical replication from the libc cluster to a new ICU cluster, then cut over. See [`74-logical-replication.md`](./74-logical-replication.md).

### Recipe 9: Inspect available collations

    SELECT
        n.nspname AS schema,
        c.collname,
        CASE c.collprovider
            WHEN 'b' THEN 'builtin'
            WHEN 'c' THEN 'libc'
            WHEN 'i' THEN 'icu'
        END AS provider,
        c.collisdeterministic AS deterministic,
        pg_encoding_to_char(c.collencoding) AS encoding,
        c.colllocale,
        c.collcollate,
        c.collctype
    FROM pg_collation c
    JOIN pg_namespace n ON n.oid = c.collnamespace
    ORDER BY provider, c.collname;

For just the cluster default + interesting locales:

    SELECT * FROM pg_collation
    WHERE collname IN ('default', 'C', 'POSIX', 'ucs_basic', 'unicode')
       OR collname LIKE 'en%' OR collname LIKE 'de%';

### Recipe 10: Test what a collation does to your data

Before changing a column's collation, see how the new collation orders sample rows.

    WITH samples(name) AS (
        VALUES ('Apple'), ('ant'), ('Banana'), ('björn'),
               ('Cherry'), ('ÄPFEL'), ('zebra'), ('Ärgernis')
    )
    SELECT name FROM samples ORDER BY name COLLATE "de-DE-x-icu";

    -- Expected German order: ant, Ärgernis, ÄPFEL, Apple, Banana, björn, Cherry, zebra

    SELECT name FROM samples ORDER BY name COLLATE "C";

    -- Expected C order: pure byte-order; uppercase before lowercase

### Recipe 11: PG18+ post-upgrade FTS/pg_trgm reindex

> [!WARNING] PG18 collation-provider change for FTS
> Verbatim: *"Change full text search to use the default collation provider of the cluster to read configuration files and dictionaries, rather than always using libc."* Verbatim follow-up: *"When upgrading such clusters using pg_upgrade, it is recommended to reindex all indexes related to full-text search and pg_trgm after the upgrade."*[^pg18-fts-provider]

    -- After pg_upgrade to PG18, reindex all FTS and pg_trgm indexes
    SELECT 'REINDEX INDEX CONCURRENTLY ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ';'
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_opclass op ON op.oid = ANY(i.indclass::oid[])
    WHERE op.opcname LIKE 'gin_trgm%' OR op.opcname LIKE 'gist_trgm%' OR op.opcname = 'tsvector_ops'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema');

Pipe the result through psql to execute.

### Recipe 12: Use `casefold()` for Unicode-correct case-insensitive matching (PG18+)

    -- PG≤17: LOWER() handles ASCII but misses Turkish dotless i, German ß
    SELECT lower('STRAßE');  -- → 'straße' (ß doesn't lowercase to itself, but lowercase ß exists)

    -- PG18: casefold() normalizes for matching
    SELECT casefold('STRAßE');  -- → 'strasse' (ß folds to ss)
    SELECT casefold('İSTANBUL');  -- → 'i̇stanbul' (Turkish capital I-with-dot folds to i + combining dot)

    -- Use in WHERE for Unicode-correct comparison
    WHERE casefold(input) = casefold('strasse')

### Recipe 13: Audit pg_trgm and FTS indexes pre-PG18-upgrade

    -- Find all indexes that will need reindex on PG18 upgrade
    SELECT
        n.nspname || '.' || c.relname AS index_name,
        pg_size_pretty(pg_relation_size(c.oid)) AS size,
        am.amname AS index_type
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_opclass op ON op.oid = ANY(i.indclass::oid[])
    WHERE op.opcname IN ('gin_trgm_ops', 'gist_trgm_ops', 'tsvector_ops', 'tsquery_ops')
    ORDER BY pg_relation_size(c.oid) DESC;

The reindex window scales with the total size shown. Plan accordingly.

[^pg18-fts-provider]: PG18 release notes [18.0](https://www.postgresql.org/docs/release/18.0/).

---

## Gotchas / Anti-patterns

1. **libc collation indexes silently break on glibc upgrade.** The headline operational hazard. Add `pg_database_collation_actual_version()` to weekly monitoring. Cross-reference [`23-btree-indexes.md`](./23-btree-indexes.md) gotcha #14.

2. **`REFRESH VERSION` does not validate indexes.** It only silences the WARNING. Reindex first, refresh second, never reverse order.[^refresh-no-check]

3. **Nondeterministic collations disable B-tree dedup.** Significant size and write cost on large text indexes. Worth measuring before adopting cluster-wide.[^nondet-limits]

4. **Pattern matching `LIKE`/`~`/`ILIKE` fails on nondeterministic collations pre-PG18.** Verbatim docs: *"The pattern matching operators of all three kinds do not support nondeterministic collations. If required, apply a different collation to the expression to work around this limitation."*[^pattern-nondet] PG18+ supports `LIKE` only — `~` and `ILIKE` still error.

5. **`SQL_ASCII` is not "ASCII encoding" — it's "no encoding declared."** Allows arbitrary bytes; no validation, no conversion. Mixed-encoding silent corruption.[^sql-ascii-warn]

6. **`initdb --no-locale` + libc gives SQL_ASCII default.** Verbatim docs: *"If `--no-locale` is specified (or equivalently, if the locale is `C` or `POSIX`), then the default is `UTF8` for the ICU provider and `SQL_ASCII` for the `libc` provider."*[^initdb-encoding-default] Always specify `--encoding=UTF8` explicitly.

7. **Database encoding cannot be changed without dump/restore.** Plan UTF-8 at `initdb` time; converting later requires dump → drop → create → restore.

8. **libc collation names depend on the OS.** `en_US.UTF-8` on Linux is `en-US.UTF-8` on macOS; Windows uses `English_United States.1252`. Migrating a `pg_dump` from one OS to another with locale-pinned columns may fail. ICU avoids this.

9. **PG17 column renames break monitoring queries.** Any query referencing `pg_collation.colliculocale` or `pg_database.daticulocale` returns NULL or errors on PG17+. Update to `colllocale` / `datlocale`. Cross-reference [`64-system-catalogs.md`](./64-system-catalogs.md).[^pg17-rename]

10. **PG18 FTS / pg_trgm reindex requirement.** Even after a clean pg_upgrade, FTS indexes built on PG≤17 against a non-libc default-provider cluster will produce different results on PG18. Reindex bundled with the upgrade.[^pg18-fts-provider]

11. **Mixing ICU and libc collations in one query needs explicit casts.** *"You cannot use collations supplied by ICU together with most of the libc collations"* — common error message: `COLLATION "foo" is not valid for encoding "UTF8"`. Cast to the same collation explicitly: `col1 COLLATE "C" = col2 COLLATE "C"`.

12. **`COLLATE` on `bytea` is a syntax error.** Collations apply only to text-like types (`text`, `varchar`, `char`, `name`, `citext`). `bytea` is byte-equality only.

13. **`citext` is comparison-only case-insensitive.** It does not normalize Unicode forms; `'Café' = 'Café'` (composed vs decomposed) returns `false` even with `citext`. For full Unicode-correct case-insensitive matching, use a nondeterministic ICU collation or PG18 `casefold()`.

14. **Standby must match primary's encoding.** Streaming replication requires byte-for-byte heap match; standby's collation must be the same provider/version. A standby on a different glibc version is fragile. Pin OS versions or use builtin/ICU.

15. **`pg_upgrade` keeps the old encoding and locale.** It does not migrate libc → ICU. Use dump/restore or logical replication for provider migration.

16. **`LC_TIME` / `LC_NUMERIC` / `LC_MONETARY` are separate from collation.** They affect `to_char` / `to_date` formatting but not sort order. Cross-reference [`14-data-types-builtin.md`](./14-data-types-builtin.md) (money type) and [`19-timestamp-timezones.md`](./19-timestamp-timezones.md).

17. **Collation defaults inherit at creation time, not lookup time.** `CREATE TABLE t (c text)` records the database default collation in `pg_attribute.attcollation`. Changing the database default later does NOT change existing columns.

18. **Nondeterministic collation indexes have no equality optimization.** A B-tree index on `text COLLATE case_insensitive` cannot do early-termination range scans for equality; the planner falls back to full-index walks for some operators.[^nondet-limits]

19. **PG18 PK/FK collation constraint silently rejects some legacy schemas.** Verbatim release note: *"Require primary/foreign key relationships to use either deterministic collations or the same nondeterministic collations."* Mixed-collation PK/FK pairs that worked on PG17 may fail to validate on PG18.[^pg18-pkfk]

20. **`pg_amcheck` (PG14+) is the canonical validator for libc-upgrade-driven corruption.** Run after any glibc upgrade and after `REFRESH VERSION`. Cross-reference [`23-btree-indexes.md`](./23-btree-indexes.md) gotcha #14 and [`88-corruption-recovery.md`](./88-corruption-recovery.md).

21. **`normalize()` and `casefold()` require UTF-8 encoding.** Verbatim: *"This function can only be used when the server encoding is `UTF8`."* On non-UTF-8 clusters, both error out at parse time.[^normalize][^casefold]

22. **Replicating across collation providers is fine for streaming, risky for logical.** Streaming replication ships heap bytes; the standby uses its own collation rules for query evaluation. Logical replication ships row values; if PK uses nondeterministic collation, the subscriber's collation must agree or apply will fail.

23. **PG13 and PG14 had no collation/encoding release-note items.** If a tutorial claims PG14 added "ICU defaults" or "nondeterministic improvements," verify against the release notes directly. The surface was stable across both versions.

[^pattern-nondet]: PG16 [functions-matching.html](https://www.postgresql.org/docs/16/functions-matching.html).

---

## See Also

- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — text/varchar/char and the citext extension
- [`23-btree-indexes.md`](./23-btree-indexes.md) — `text_pattern_ops` opclass for C-locale pattern matching; libc-collation-upgrade gotcha #14
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — pg_trgm and tsvector indexes affected by PG18 FTS provider change
- [`20-text-search.md`](./20-text-search.md) — FTS configurations and the PG18 provider-default change
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_collation` / `pg_database` columns including PG17 renames
- [`73-streaming-replication.md`](./73-streaming-replication.md) — collation rules must match primary + standby
- [`74-logical-replication.md`](./74-logical-replication.md) — zero-downtime locale-provider migration via logical replication
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — PG18 FTS/pg_trgm reindex requirement after upgrade
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — `pg_amcheck` for detecting collation-driven B-tree corruption
- [`93-pg-trgm.md`](./93-pg-trgm.md) — pg_trgm extension; PG18 reindex requirement
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling weekly `pg_database_collation_actual_version` audit

---

## Sources

- PG16 [Locale Support — chapter 24.1](https://www.postgresql.org/docs/16/locale.html)
- PG16 [Collation Support — chapter 24.2](https://www.postgresql.org/docs/16/collation.html)
- PG16 [Character Set Support — chapter 24.3](https://www.postgresql.org/docs/16/multibyte.html)
- PG16 [CREATE COLLATION](https://www.postgresql.org/docs/16/sql-createcollation.html)
- PG16 [ALTER COLLATION](https://www.postgresql.org/docs/16/sql-altercollation.html)
- PG16 [CREATE DATABASE](https://www.postgresql.org/docs/16/sql-createdatabase.html)
- PG16 [ALTER DATABASE](https://www.postgresql.org/docs/16/sql-alterdatabase.html)
- PG16 [initdb](https://www.postgresql.org/docs/16/app-initdb.html)
- PG16 [pg_collation catalog](https://www.postgresql.org/docs/16/catalog-pg-collation.html)
- PG16 [pg_database catalog](https://www.postgresql.org/docs/15/catalog-pg-database.html)
- PG16 [Functions: String — normalize()](https://www.postgresql.org/docs/16/functions-string.html)
- PG16 [Pattern Matching — nondeterministic collation limits](https://www.postgresql.org/docs/16/functions-matching.html)
- PG17 [Locale Support](https://www.postgresql.org/docs/17/locale.html) — builtin provider, PG_C_UTF8
- PG17 [Collation Support](https://www.postgresql.org/docs/17/collation.html)
- PG17 [pg_collation catalog — colllocale](https://www.postgresql.org/docs/17/catalog-pg-collation.html)
- PG17 [pg_database catalog — datlocale](https://www.postgresql.org/docs/17/catalog-pg-database.html)
- PG18 [Locale Support](https://www.postgresql.org/docs/18/locale.html) — PG_UNICODE_FAST
- PG18 [Collation Support](https://www.postgresql.org/docs/18/collation.html) — pg_unicode_fast
- PG18 [Functions: String — casefold()](https://www.postgresql.org/docs/18/functions-string.html)
- PG12 [Release Notes — nondeterministic collations](https://www.postgresql.org/docs/release/12.0/)
- PG15 [Release Notes — datcollversion, REFRESH COLLATION VERSION](https://www.postgresql.org/docs/release/15.0/)
- PG16 [Release Notes — ICU build-by-default](https://www.postgresql.org/docs/release/16.0/)
- PG17 [Release Notes — builtin provider, catalog renames](https://www.postgresql.org/docs/release/17.0/)
- PG18 [Release Notes — PG_UNICODE_FAST, casefold(), FTS provider change](https://www.postgresql.org/docs/release/18.0/)

# Procedural Languages (PL/Python, PL/Perl, PL/Tcl, PL/v8)

PostgreSQL ships with **four** in-tree procedural languages: PL/pgSQL, PL/Tcl, PL/Perl, and PL/Python.[^xplang] Anything else (PL/v8, PL/Java, PL/R, PL/Lua, PL/Rust, etc.) is an out-of-tree extension. This file covers everything *except* PL/pgSQL — that has its own deep reference at [08-plpgsql.md](./08-plpgsql.md). The deep dive on dynamic SQL with `EXECUTE` and `quote_*` lives in [10-dynamic-sql.md](./10-dynamic-sql.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Syntax / Mechanics](#syntax--mechanics)
    - [The TRUSTED / UNTRUSTED distinction](#the-trusted--untrusted-distinction)
    - [Language inventory at a glance](#language-inventory-at-a-glance)
    - [Installing a procedural language](#installing-a-procedural-language)
    - [Calling SPI from a PL](#calling-spi-from-a-pl)
    - [PL/Python (`plpython3u`)](#plpython-plpython3u)
    - [PL/Perl (`plperl`, `plperlu`)](#plperl-plperl-plperlu)
    - [PL/Tcl (`pltcl`, `pltclu`)](#pltcl-pltcl-pltclu)
    - [PL/v8 (external extension)](#plv8-external-extension)
    - [Other out-of-tree PLs](#other-out-of-tree-pls)
- [Examples / Recipes](#examples--recipes)
    - [1. Choosing a language (decision flowchart)](#1-choosing-a-language-decision-flowchart)
    - [2. PL/Python: regex-rich text munging](#2-plpython-regex-rich-text-munging)
    - [3. PL/Python: calling a stdlib library safely](#3-plpython-calling-a-stdlib-library-safely)
    - [4. PL/Python: SPI access (plpy.execute, plpy.prepare)](#4-plpython-spi-access-plpyexecute-plpyprepare)
    - [5. PL/Python: error handling and subtransactions](#5-plpython-error-handling-and-subtransactions)
    - [6. PL/Python: set-returning function](#6-plpython-set-returning-function)
    - [7. PL/Python: trigger function](#7-plpython-trigger-function)
    - [8. PL/Perl: regex / text helpers in a trusted body](#8-plperl-regex--text-helpers-in-a-trusted-body)
    - [9. PL/Perl: SPI access (spi_exec_query, spi_prepare)](#9-plperl-spi-access-spi_exec_query-spi_prepare)
    - [10. PL/Tcl: tiny helper using Tcl's string ops](#10-pltcl-tiny-helper-using-tcls-string-ops)
    - [11. PL/v8: validating a JSON payload before insert](#11-plv8-validating-a-json-payload-before-insert)
    - [12. Auditing what PLs and extensions are installed](#12-auditing-what-pls-and-extensions-are-installed)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Reach for this file when:

- You need a procedural language and want to know which one to pick. PL/pgSQL is the safe default for anything that is "SQL with a thin imperative wrapper"; the alternatives here exist for the cases PL/pgSQL is bad at.
- You need to call out from inside the database to something Python / Perl / Tcl / JS does well — regular expressions richer than POSIX, NumPy / Pandas-style numeric work, string parsing that would be miserable in PL/pgSQL, JSON Schema validation, third-party libraries.
- You hit `ERROR: language "plpython3u" does not exist` or similar after `CREATE FUNCTION ... LANGUAGE ...` and need to install the language.
- A migration breaks because the target server is a managed service that disallows the language. The categorical limitations are summarised in the gotchas and in [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md).
- You are auditing a database for risky `LANGUAGE plpython3u` / `plperlu` definers, or planning a major-version upgrade that may move you off Python 2 / older Perl.

For PL/pgSQL see [`08-plpgsql.md`](./08-plpgsql.md). For dynamic SQL see [`10-dynamic-sql.md`](./10-dynamic-sql.md). For C extensions and custom PLs see [`72-extension-development.md`](./72-extension-development.md).

## Syntax / Mechanics

### The TRUSTED / UNTRUSTED distinction

The single most important fact about every PL in this file is whether it is *trusted* or *untrusted*. PostgreSQL itself defines the line very narrowly:

> "`TRUSTED` specifies that the language does not grant access to data that the user would not otherwise have."[^createlang-trusted]

In practice:

| Property | Trusted PL | Untrusted PL |
|---|---|---|
| Suffix convention | bare name (`plperl`, `pltcl`) | `u` suffix (`plperlu`, `pltclu`, `plpython3u`) |
| Who can create functions | Any role with `USAGE` on the language (granted to `PUBLIC` by default for trusted languages)[^createlang-usage] | Only superuser, or via `SECURITY DEFINER` wrapper |
| What the language can do | Only operations the back end can validate as memory- and database-safe; no filesystem, no network, no environment, no loading arbitrary modules | Anything the OS user running the postmaster can do — including reading files, opening sockets, spawning processes |
| Registration syntax | `CREATE EXTENSION plperl;` (control file declares the language `TRUSTED`) | `CREATE EXTENSION plperlu;` |
| Use case | Pure compute that should run on behalf of any caller | Code that genuinely needs the host OS |

Two corollaries that surprise developers:

1. **`LANGUAGE plpython3u` is the *only* form of PL/Python in modern PostgreSQL.** There is no trusted PL/Python.[^plpython-untrusted]
2. **`CREATE LANGUAGE` itself requires superuser, even for trusted languages.** Once registered though, the language can be re-owned and re-granted to non-superusers.[^createlang-superuser] In PG13 and later, *trusted extensions* let a non-superuser with `CREATE` on the database run `CREATE EXTENSION plperl;` — but the script underneath still runs as the bootstrap superuser.[^pg13-trusted-ext]

> [!NOTE] PostgreSQL 13
> PG13 added the `trusted = true` flag in extension control files. A trusted extension can be installed by any role with `CREATE` privilege on the database, and the install script runs as the bootstrap superuser.[^pg13-trusted-ext] [^ext-trusted] Among the in-tree PLs, `plperl`, `pltcl`, and `plpgsql` ship as trusted extensions; `plperlu`, `pltclu`, and `plpython3u` do **not** — the latter group still requires superuser to install.

### Language inventory at a glance

| Language | Built into PG distribution? | Trusted variant | Untrusted variant | What it's actually for |
|---|---|---|---|---|
| PL/pgSQL | Yes — installed by default in `template1` | `plpgsql` | (n/a — has nothing to gain from being untrusted) | SQL with imperative glue. Default choice. See [08-plpgsql.md](./08-plpgsql.md). |
| PL/Tcl | Yes (`--with-tcl` build) | `pltcl` | `pltclu` | Tcl-style string manipulation, integration with Tcl shops. Rare in greenfield work. |
| PL/Perl | Yes (`--with-perl` build) | `plperl` | `plperlu` | Regex- and string-heavy work, CPAN module access (untrusted only). Common for legacy systems. |
| PL/Python | Yes (`--with-python` build) | none | `plpython3u` | Stdlib-rich logic, NumPy/Pandas calls, calling out to external services. **Untrusted only.** |
| PL/v8 | External (`plv8`)[^plv8] | `plv8` (trusted) | `plv8u`? — historically `plv8` only had a trusted form | JavaScript bodies, JSON-heavy logic, sharing code with a Node.js frontend. |
| PL/Java | External (`pljava`) | `pljava` | `pljavau` | Reuse a JVM library inside the database. |
| PL/R | External (`plr`) | none | `plr` | Statistical analysis in R against in-database data. |
| PL/Lua | External (`pllua`) | `pllua` | `plluau` | Lightweight scripting in Lua. |
| PL/Rust | External (`plrust`) | `plrust` (sandboxed via WASM-like restrictions) | n/a | Memory-safe Rust bodies; relatively new. |

> [!WARNING] Removed/Deprecated
> `plpythonu` and `plpython2u` (PL/Python on Python 2) are obsolete. PG13 dropped support for Python 2.5.X and earlier;[^pg13-py25] subsequent releases progressively removed support for the rest of Python 2.x as Python 2 itself reached end of life (Jan 2020) and packagers stopped shipping it. Any documentation or third-party post mentioning `plpython2u` predates the PG13 era. **Use `plpython3u`** — that is the only PL/Python you should be writing today.

### Installing a procedural language

For an in-tree PL, the package layout is two artifacts: a shared object (`plperl.so`, `pltcl.so`, `plpython3.so`) and a control file (`plperl.control`, etc.). On a self-hosted server you typically install an OS package:

    # Debian / Ubuntu (example only — adapt to your distro)
    apt-get install postgresql-plperl-16 postgresql-plpython3-16 postgresql-pltcl-16

Then per-database:

    -- Trusted: anyone with CREATE on the database can do this if the extension is also marked trusted (PG13+).
    CREATE EXTENSION plperl;
    CREATE EXTENSION pltcl;

    -- Untrusted: always requires superuser to install.
    CREATE EXTENSION plperlu;
    CREATE EXTENSION pltclu;
    CREATE EXTENSION plpython3u;

> [!NOTE] PostgreSQL 16
> On a fresh PG16+ install `CREATE EXTENSION plpgsql` is a no-op because the language is created in `template1` by `initdb`. The other PLs must be explicitly installed in each database.

You can confirm what is installed:

    -- All registered procedural languages in this database
    SELECT lanname, lanpltrusted, lanowner::regrole
    FROM pg_language
    ORDER BY lanname;

    -- All extensions installed in this database, with their versions
    SELECT extname, extversion, extowner::regrole, extnamespace::regnamespace
    FROM pg_extension
    ORDER BY extname;

After `DROP EXTENSION plperl;` any function previously written `LANGUAGE plperl` is gone — `DROP EXTENSION` cascades to dependent objects. Run it inside a transaction so you can `ROLLBACK` if too much disappears.

### Calling SPI from a PL

Every PL gives function bodies a way to issue SQL back at the database via the Server Programming Interface (SPI). The shape of the API is a little different in each:

| Language | Run a query | Parameterised query | Iterate result | Capture errors |
|---|---|---|---|---|
| PL/pgSQL | `PERFORM` / `SELECT INTO` / `EXECUTE` | `EXECUTE … USING …` | `FOR row IN …` | `EXCEPTION WHEN …` |
| PL/Python | `plpy.execute(sql)` | `plpy.prepare(sql, types) + plpy.execute(plan, args)` | iterate the result object | `try/except plpy.SPIError` |
| PL/Perl | `spi_exec_query(sql)` | `spi_prepare + spi_exec_prepared` | `for my $row (@{ $rv->{rows} })` | `eval { … }; if ($@)` |
| PL/Tcl | `spi_exec ?-array? sql code` | `spi_prepare`, `spi_execp` | `spi_exec` accepts a code body run per row | `catch { … }` |

In all cases, **using a prepared/parameterised form is mandatory if any value came from outside.** Inline string concatenation is SQL injection through a different door — see [10-dynamic-sql.md](./10-dynamic-sql.md) for the equivalent rule in PL/pgSQL.

### PL/Python (`plpython3u`)

PL/Python is *only* available as untrusted. The documentation is explicit:

> "PL/Python is only available as an 'untrusted' language, meaning it does not offer any way of restricting what users can do in it and is therefore named `plpython3u`."[^plpython-untrusted]

That means:

- Anything `import os; os.system(...)` can do — read `/etc/passwd`, fork a shell, open a socket — is allowed.
- Only a superuser can `CREATE FUNCTION ... LANGUAGE plpython3u` directly.
- The standard way to give untrusted callers a controlled slice of PL/Python is `SECURITY DEFINER` on a function whose body is small, well-validated, and whose `search_path` is pinned (see [06-functions.md](./06-functions.md#security-definer-hardening)).

Minimum runnable example:

    CREATE OR REPLACE FUNCTION normalize_phone(p_raw text)
    RETURNS text
    LANGUAGE plpython3u
    IMMUTABLE STRICT
    AS $py$
        import re
        digits = re.sub(r"\D+", "", p_raw)
        if len(digits) == 11 and digits.startswith("1"):
            digits = digits[1:]
        if len(digits) != 10:
            plpy.error(f"phone must have 10 digits, got {len(digits)}: {p_raw!r}")
        return "(" + digits[0:3] + ") " + digits[3:6] + "-" + digits[6:]
    $py$;

The body uses Python 3 syntax; `plpy` is the implicit SPI module (`plpy.execute`, `plpy.prepare`, `plpy.notice`, `plpy.warning`, `plpy.error`, `plpy.fatal`, `plpy.cursor`, `plpy.subtransaction`).

Type mapping (the most-used cells):

| SQL type | Python value |
|---|---|
| `text`, `varchar`, `char`, `name` | `str` |
| `bytea` | `bytes` |
| `int2`, `int4`, `int8` | `int` |
| `float4`, `float8`, `numeric` | `float` (or `decimal.Decimal` for `numeric` when imported) |
| `bool` | `bool` |
| `date`, `timestamp`, `timestamptz` | `datetime.date` / `datetime.datetime` |
| `jsonb` | `dict` / `list` / scalar (decoded automatically) |
| `array[T]` | `list[python(T)]` |
| `record` / composite | `dict` |
| `NULL` | `None` |

> [!NOTE] PostgreSQL 14
> PL/Python (and the other in-tree PLs) gained support for procedure `OUT` parameters in PG14, mirroring the procedure-level change.[^pg14-out] Inside a procedure you can `return [val1, val2]` to populate multiple `OUT` columns.

### PL/Perl (`plperl`, `plperlu`)

PL/Perl ships in two variants. The trusted `plperl` runs inside Perl's opcode-restricted sandbox; the untrusted `plperlu` does not:

> "In general, the operations that are restricted are those that interact with the environment. This includes file handle operations, `require`, and `use` (for external modules)."[^plperl-trusted]

Trusted PL/Perl is the one of the four built-in PLs that is most often "good enough" for ad-hoc text munging without crossing the trust boundary. Things you can do in `plperl`:

- All of Perl's core regex features (named captures, `qr//`, look-around, modifiers — far more than POSIX regex in pure SQL).
- `for`, `while`, hashes, arrays, references.
- SPI helpers: `spi_exec_query`, `spi_prepare`, `spi_exec_prepared`, `spi_query`, `spi_fetchrow`, `spi_cursor_close`, `spi_commit`, `spi_rollback`, `elog`.

Things you cannot do in `plperl` (would need `plperlu`):

- `use IO::Socket` (or any module that opens a file/socket from disk).
- `open my $fh, '>', '/tmp/whatever'`.
- `require Some::CPAN::Module`.
- `system(...)`, ``backticks``.

The trusted/untrusted check fires at *validation time* — the function refuses to compile, not just refuses to run.[^plperl-trusted] So a CI step that calls `CREATE FUNCTION` against a target PG version catches forbidden ops without needing the trapped behavior at runtime.

Minimum runnable example (trusted):

    CREATE OR REPLACE FUNCTION pluck_emails(p_text text)
    RETURNS text[]
    LANGUAGE plperl
    IMMUTABLE STRICT
    AS $perl$
        my @addrs;
        while ($_[0] =~ /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g) {
            push @addrs, $1;
        }
        return \@addrs;  # return arrayref for SQL array
    $perl$;

The function returns a `text[]` because the Perl body returns an arrayref. (PL/Perl uses arrayrefs and hashrefs to represent composite return values.)

### PL/Tcl (`pltcl`, `pltclu`)

PL/Tcl is the least-used of the four in-tree PLs in greenfield code, but the trusted `pltcl` is also the *most* sandboxed because it runs in Safe Tcl:

> "Everything is executed from within the safety of the context of a Tcl interpreter… Thus, unprivileged database users can be trusted to use this language; it does not give them unlimited authority."[^pltcl-overview]

The restricted set:

> "Only a few commands are available to access the database via SPI and to raise messages via `elog()`. PL/Tcl provides no way to access internals of the database server or to gain OS-level access under the permissions of the PostgreSQL server process."[^pltcl-overview]

Minimum runnable example:

    CREATE OR REPLACE FUNCTION pad_left(s text, n int4, ch text DEFAULT ' ')
    RETURNS text
    LANGUAGE pltcl
    IMMUTABLE STRICT
    AS $tcl$
        set pad [string repeat $3 [expr {$2 - [string length $1]}]]
        return "$pad$1"
    $tcl$;

Positional arguments are `$1`, `$2`, … inside the body. The SPI vocabulary is `spi_exec`, `spi_prepare`, `spi_execp`, `spi_lastoid`, `elog`.

### PL/v8 (external extension)

PL/v8 is the JavaScript PL, powered by Google's V8 engine. It is **not** in core or contrib; it ships as a separate extension at https://github.com/plv8/plv8.[^plv8]

Why a team picks it:

- The frontend already speaks JavaScript and the in-database functions can share validation logic, regex, or schema definitions with the client.
- JSON-heavy logic — V8 handles JSON objects natively, so jsonb→JS object→jsonb round-trips are cheap.
- Per-function caching of compiled scripts inside the V8 isolate, which can be faster than equivalent PL/pgSQL for hot, compute-heavy bodies.

The trade-off:

- A second native dependency (V8) that the DBA must build, package, and patch.
- Many managed Postgres environments **do not** include PL/v8 in their extension allowlist; categorically, expect it to be unavailable on managed services unless the provider publishes it as a supported extension. (See [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md) for the class of limitation.)
- Memory: a V8 isolate holds its heap for the lifetime of the backend, so connection churn means re-paying the isolate startup cost. Use a connection pooler (see [81-pgbouncer.md](./81-pgbouncer.md)).

Minimum runnable example:

    CREATE EXTENSION IF NOT EXISTS plv8;

    CREATE OR REPLACE FUNCTION js_strip_keys(payload jsonb, keys_to_drop text[])
    RETURNS jsonb
    LANGUAGE plv8
    IMMUTABLE STRICT
    AS $js$
        const drop = new Set(keys_to_drop);
        const result = {};
        for (const k of Object.keys(payload)) {
            if (!drop.has(k)) result[k] = payload[k];
        }
        return result;
    $js$;

Inside a PL/v8 body, the SPI module is `plv8`: `plv8.execute(sql, args)`, `plv8.prepare(sql, types)`, `plv8.subtransaction(fn)`, `plv8.elog(LEVEL, ...)`.

### Other out-of-tree PLs

- **PL/Java** — JVM bytecode in the database. Useful when a substantial library exists only in Java; pays a JVM-startup cost per backend and is heavy on memory.
- **PL/R** — R bodies for statistical work, hooks into the same SPI shape. Heavy. Tends to be useful only when the data must not leave the database for compliance or volume reasons.
- **PL/Lua** — Lua bodies. Small footprint, fast startup. Less common.
- **PL/Rust** — Memory-safe Rust bodies; relatively new. Aims to be a "trusted" alternative for performance-critical code that would otherwise need a C extension.

None of these is shipped with the core distribution; each is a separate extension with its own version-compatibility matrix against PG majors. Verify support for your target PG major before depending on them.

## Examples / Recipes

### 1. Choosing a language (decision flowchart)

> [!IMPORTANT] Default is PL/pgSQL.
> PL/pgSQL is the right choice for in-database imperative work. The other PLs exist for cases where PL/pgSQL is genuinely awkward — usually because the body needs a library, a richer regex flavor, or a host-OS capability.

    Need to call OS / network / filesystem / arbitrary module?
        Yes  → only a *u* language can do it. Pick the one you already use:
                - plpython3u for stdlib breadth + popular libraries
                - plperlu for CPAN-heavy shops
                - pltclu only if your shop is Tcl-native
               You will need superuser to create the function, or wrap it
               in a SECURITY DEFINER function created by a superuser.
        No   → continue below.

    Body is mostly SQL with thin control flow / DECLARE + variables?
        Yes  → PL/pgSQL. See 08-plpgsql.md.
        No   → continue below.

    Need rich regex or string parsing that POSIX regex doesn't cover?
        Yes  → trusted PL/Perl. The Perl regex engine is the right tool.
        No   → continue below.

    Need stdlib breadth (statistics, parsing, RFC formats) without the OS?
        Yes  → no good answer in stock PostgreSQL. plpython3u is the answer
               for "stdlib breadth" but only as a superuser-installed *u*
               language. Wrap it in SECURITY DEFINER.

    Need JSON manipulation that goes beyond jsonb operators?
        Yes  → plv8 if you can install it. Otherwise plpython3u or PL/pgSQL
               + jsonb_* helpers.

    Need JVM library reuse?
        Yes  → PL/Java. Expect operational weight (JVM per backend).

    Need statistical / numerical computing on in-DB data?
        Yes  → PL/R or plpython3u + numpy/pandas. Often the right answer
               is "extract to a side process via FDW or a worker job."

### 2. PL/Python: regex-rich text munging

A common case: cleaning user-entered identifiers down to a canonical form.

    CREATE OR REPLACE FUNCTION canonical_slug(p_raw text)
    RETURNS text
    LANGUAGE plpython3u
    IMMUTABLE STRICT
    AS $py$
        import re
        import unicodedata
        s = unicodedata.normalize("NFKD", p_raw)
        s = s.encode("ascii", "ignore").decode("ascii")
        s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
        if not s:
            plpy.error("slug is empty after normalization")
        return s
    $py$;

    SELECT canonical_slug('Café — Niño''s Place!');
    -- => 'cafe-nino-s-place'

This uses the Python stdlib's Unicode NFKD decomposition, which is materially more complete than what `unaccent` (the contrib extension) gives you. Mark `IMMUTABLE STRICT` so the planner can use it in an expression index — `CREATE INDEX ON places ((canonical_slug(name)));` is a viable pattern. Note that `IMMUTABLE` is a *promise* — if you change the body so it stops producing the same output for the same input, indexes built on it silently rot. See [06-functions.md](./06-functions.md#volatility-classes).

### 3. PL/Python: calling a stdlib library safely

Generating a v7 UUID (time-ordered) is straightforward in Python ≥ 3.13. Until your PG18 backend's bundled Python gets that version, you can emulate v7:

    CREATE OR REPLACE FUNCTION uuid_v7()
    RETURNS uuid
    LANGUAGE plpython3u
    VOLATILE
    AS $py$
        import os, time, uuid
        unix_ms = int(time.time() * 1000)
        ts = unix_ms.to_bytes(6, "big")
        rand = os.urandom(10)
        # set version to 7 (high nibble of byte 6)
        b = bytearray(ts + rand)
        b[6] = (b[6] & 0x0F) | 0x70
        # set variant to RFC 4122 (high two bits of byte 8)
        b[8] = (b[8] & 0x3F) | 0x80
        return str(uuid.UUID(bytes=bytes(b)))
    $py$;

> [!NOTE] PostgreSQL 18
> PG18 added a *native* `uuidv7()` SQL function in core — use that on PG18 in preference to a PL/Python implementation.[^pg18-uuidv7] The PL/Python version is appropriate when you are stuck on PG ≤ 17 and cannot install the `pg_uuidv7` contrib extension.

### 4. PL/Python: SPI access (plpy.execute, plpy.prepare)

The wrong way:

    -- BAD: SQL injection
    CREATE OR REPLACE FUNCTION find_by_email(p_email text)
    RETURNS SETOF users
    LANGUAGE plpython3u
    AS $py$
        rv = plpy.execute("SELECT * FROM users WHERE email = '" + p_email + "'")
        return list(rv)
    $py$;

The right way — prepare once per session, cache the plan in a globals dict so subsequent calls inside the same backend skip parse + plan:

    CREATE OR REPLACE FUNCTION find_by_email(p_email text)
    RETURNS SETOF users
    LANGUAGE plpython3u
    AS $py$
        if "find_by_email_plan" not in SD:
            SD["find_by_email_plan"] = plpy.prepare(
                "SELECT * FROM users WHERE email = $1", ["text"]
            )
        rv = plpy.execute(SD["find_by_email_plan"], [p_email])
        return list(rv)
    $py$;

`SD` is the per-function shared dictionary that persists for the life of the backend (`GD` is database-global across functions). Cached plans inherit the same generic-vs-custom planning rules described in [13-cursors-and-prepares.md](./13-cursors-and-prepares.md).

### 5. PL/Python: error handling and subtransactions

PL/Python exceptions map to PostgreSQL errors via `plpy.SPIError`. To recover from a unique-violation inside a function body, wrap the offending SPI call in a subtransaction (otherwise the outer transaction is doomed):

    CREATE OR REPLACE FUNCTION insert_if_absent(p_id int, p_label text)
    RETURNS bool
    LANGUAGE plpython3u
    AS $py$
        try:
            with plpy.subtransaction():
                plpy.execute(plpy.prepare(
                    "INSERT INTO labels(id,label) VALUES ($1,$2)",
                    ["int4","text"]
                ), [p_id, p_label])
            return True
        except plpy.SPIError as e:
            if e.sqlstate == "23505":  # unique_violation
                return False
            raise
    $py$;

Like in PL/pgSQL, each `with plpy.subtransaction():` block creates a real PostgreSQL subtransaction, consumes a XID, and stresses the `pg_subtrans` SLRU under high write rate. See [08-plpgsql.md](./08-plpgsql.md#exception-handling) for the same gotcha in the SQL-level language.

### 6. PL/Python: set-returning function

Return rows by `yield`-ing or by returning an iterable:

    CREATE TYPE word_count AS (word text, n bigint);

    CREATE OR REPLACE FUNCTION word_counts(p_text text)
    RETURNS SETOF word_count
    LANGUAGE plpython3u
    IMMUTABLE STRICT
    AS $py$
        from collections import Counter
        import re
        words = re.findall(r"\w+", p_text.lower())
        for w, n in Counter(words).most_common():
            yield {"word": w, "n": n}
    $py$;

    SELECT * FROM word_counts('alpha beta alpha gamma alpha beta');
    --  word   | n
    -- --------+---
    --  alpha  | 3
    --  beta   | 2
    --  gamma  | 1

Compare with `RETURNS TABLE(...)` syntax described in [06-functions.md](./06-functions.md#returns-table-and-out-parameters).

### 7. PL/Python: trigger function

Trigger functions in PL/Python receive the row in `TD` (trigger data):

    CREATE OR REPLACE FUNCTION trg_audit_payload()
    RETURNS trigger
    LANGUAGE plpython3u
    AS $py$
        import json
        # Audit only the fields actually changed on UPDATE
        if TD["event"] == "UPDATE":
            diff = {
                k: {"old": TD["old"][k], "new": TD["new"][k]}
                for k in TD["new"]
                if TD["new"][k] != TD["old"].get(k)
            }
            plpy.execute(plpy.prepare(
                "INSERT INTO audit_log(table_name, pk, diff) VALUES ($1,$2,$3::jsonb)",
                ["text","int4","text"]
            ), [TD["table_name"], TD["new"]["id"], json.dumps(diff)])
        # Returning "OK" keeps NEW as-is; "MODIFY" with TD["new"] applies edits;
        # "SKIP" discards the row.
        return "OK"
    $py$;

    CREATE TRIGGER audit_users
    AFTER UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trg_audit_payload();

See [39-triggers.md](./39-triggers.md) for the full trigger surface; the PL/Python `TD` dict mirrors the `NEW`/`OLD`/`TG_OP` variables you would see in PL/pgSQL.

### 8. PL/Perl: regex / text helpers in a trusted body

A common pattern is splitting a free-form audit string into structured columns. Perl's regex flavour makes this much easier than POSIX regex in `regexp_match`:

    CREATE OR REPLACE FUNCTION parse_log_line(p_line text)
    RETURNS TABLE(ts timestamptz, level text, msg text)
    LANGUAGE plperl
    IMMUTABLE STRICT
    AS $perl$
        my ($line) = @_;
        if ($line =~ /
            ^
            (?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) \s+
            \[(?<level>DEBUG|INFO|WARN|ERROR|FATAL)\] \s+
            (?<msg>.*)
            $
        /x) {
            return [{ ts => $+{ts}, level => $+{level}, msg => $+{msg} }];
        }
        return [];
    $perl$;

    SELECT * FROM parse_log_line('2026-05-11T07:53:14.812Z [WARN] subtransactions hot');
    --              ts             | level |             msg
    -- ----------------------------+-------+-----------------------------
    --  2026-05-11 07:53:14.812+00 | WARN  | subtransactions hot

Returning an arrayref of hashrefs gives you a SETOF. Returning a bare hashref gives you a single row. Named captures (`?<name>...`) are a Perl regex feature absent from PostgreSQL's POSIX engine.

### 9. PL/Perl: SPI access (spi_exec_query, spi_prepare)

Bad — string concat:

    -- BAD
    spi_exec_query("SELECT * FROM users WHERE email = '$email'");

Good — prepared plan, cached in `$_SHARED` for backend lifetime:

    CREATE OR REPLACE FUNCTION find_user(p_email text)
    RETURNS users
    LANGUAGE plperl
    AS $perl$
        my ($email) = @_;
        $_SHARED{find_user_plan} //= spi_prepare(
            'SELECT * FROM users WHERE email = $1', 'text'
        );
        my $rv = spi_exec_prepared($_SHARED{find_user_plan}, $email);
        return $rv->{rows}->[0];
    $perl$;

PL/Perl exposes `$_SHARED` (analogous to PL/Python's `GD`) and `$_TD` inside trigger bodies.

### 10. PL/Tcl: tiny helper using Tcl's string ops

    CREATE OR REPLACE FUNCTION wrap_text(s text, width int4)
    RETURNS text
    LANGUAGE pltcl
    IMMUTABLE STRICT
    AS $tcl$
        set words [split $1 " "]
        set line  ""
        set out   ""
        foreach w $words {
            if {[string length $line] + [string length $w] + 1 > $2} {
                append out "$line\n"
                set line $w
            } elseif {$line eq ""} {
                set line $w
            } else {
                append line " $w"
            }
        }
        append out $line
        return $out
    $tcl$;

PL/Tcl is rarely the right choice in greenfield code, but it stays useful when an existing Tcl codebase needs to push some logic database-side.

### 11. PL/v8: validating a JSON payload before insert

V8's JSON support means `jsonb` round-trips are essentially native objects:

    CREATE EXTENSION IF NOT EXISTS plv8;

    CREATE OR REPLACE FUNCTION validate_order(p_order jsonb)
    RETURNS jsonb
    LANGUAGE plv8
    IMMUTABLE STRICT
    AS $js$
        const order = p_order;
        const errors = [];

        if (!order.id || typeof order.id !== "string") errors.push("id required (string)");
        if (!Array.isArray(order.lines) || order.lines.length === 0)
            errors.push("lines required (non-empty array)");
        const total = (order.lines || []).reduce(
            (sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unit_price) || 0),
            0
        );
        if (!Number.isFinite(total) || total < 0) errors.push("invalid total");

        return { ok: errors.length === 0, errors, total };
    $js$;

    SELECT validate_order('{"id":"o-1","lines":[{"qty":2,"unit_price":9.99}]}'::jsonb);
    -- => {"ok": true, "errors": [], "total": 19.98}

The same logic in PL/pgSQL would be three times as long and four times as ugly because of repeated `->>` / `::numeric` casting. The same logic in PL/Python would also work but `plpython3u` is untrusted; `plv8` runs in a sandboxed V8 isolate and is trusted, so any caller with `USAGE ON LANGUAGE plv8` can invoke this function.

### 12. Auditing what PLs and extensions are installed

For a security review or upgrade pre-flight:

    -- All procedural languages, with trusted flag and ownership
    SELECT l.lanname,
           l.lanpltrusted AS trusted,
           pg_get_userbyid(l.lanowner) AS owner,
           (SELECT count(*) FROM pg_proc p WHERE p.prolang = l.oid) AS function_count
    FROM pg_language l
    ORDER BY l.lanname;

    -- All functions/procedures written in an untrusted PL
    SELECT n.nspname || '.' || p.proname AS object,
           l.lanname,
           p.prosecdef AS security_definer,
           pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE l.lanpltrusted = false
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1;

    -- Functions where SECURITY DEFINER is set but search_path is NOT pinned
    SELECT n.nspname || '.' || p.proname AS object,
           l.lanname,
           p.proconfig
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND (p.proconfig IS NULL
           OR NOT EXISTS (SELECT 1
                          FROM unnest(p.proconfig) c
                          WHERE c LIKE 'search\_path=%'))
      AND n.nspname NOT IN ('pg_catalog', 'information_schema');

The last query is the same `SECURITY DEFINER` hardening audit recommended in [06-functions.md](./06-functions.md#security-definer-hardening). Every untrusted-PL function flagged is a candidate for review before a PG major upgrade.

## Gotchas / Anti-patterns

1. **PL/Python is untrusted by definition.** There is no `plpythonu` route to a sandboxed Python. If a caller can `CREATE FUNCTION ... LANGUAGE plpython3u`, that caller can `os.system("rm -rf /")`. Restrict creation to a small set of trusted authors and rely on `SECURITY DEFINER` wrappers for everything callable by application roles.[^plpython-untrusted]

2. **`SECURITY DEFINER` on a `plpython3u` function without a pinned `search_path` is a working exploit.** PG17 made the maintenance path safer (see [06-functions.md](./06-functions.md#pg17-search-path-during-maintenance)), but a Python body that runs `SELECT foo()` is still vulnerable to schema-injection if `search_path` isn't fixed. Always `SET search_path = pg_catalog, public` on the function definition.

3. **Untrusted PLs are usually disabled on managed services.** Most managed providers either omit `plpython3u` / `plperlu` / `pltclu` entirely or hide them behind a paid SKU. **Class of limitation:** anything that needs OS access. Categorical answer: write the logic in a trusted PL (PL/pgSQL, PL/Perl, PL/v8 if available) or move it out of the database. See [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md).

4. **PL/v8 is *not* in core or contrib.** It's the GitHub extension at `plv8/plv8`.[^plv8] Many managed services do not include it in the allowlist. Treat its availability as "verify per cluster," not as something you can rely on.

5. **PL/Java, PL/R, PL/Lua, PL/Rust are also out-of-tree.** Their PG-version-compatibility matrices lag the core release. Before scheduling a major PG upgrade, check upstream support for every non-core PL you depend on.

6. **`plpython2u` / `plpythonu` are obsolete.** PG13 dropped the older Python 2 lines.[^pg13-py25] Modern PG ships with Python 3 only. If a vendored function uses `plpython2u`, it must be ported to `plpython3u` (which is mostly mechanical — Python 3 syntax, `print(...)`, `bytes`/`str` distinction) before the next major upgrade.

7. **Per-language interpreter state is backend-scoped and grows unbounded.** PL/Python `SD`/`GD`, PL/Perl `$_SHARED`, PL/v8's V8 isolate, and PL/Java's JVM all persist for the lifetime of the backend. Two risks: (a) in transaction-mode pooling (see [81-pgbouncer.md](./81-pgbouncer.md)), the same backend serves many app sessions — cached state from one session can leak into the next; (b) stuffing request data into `GD` leaks memory across calls. Cache only what is invariant (prepared plans, parsed regex, compiled validators). Use session-mode pooling for procedures that rely on per-backend state.

9. **PL/Perl trusted mode rejects `require`/`use` at validation time, not at runtime.** That means CI can catch trusted-mode violations by `CREATE FUNCTION ... LANGUAGE plperl` against a test PG instance. If a body silently switches between trusted and untrusted depending on environment, that's a bug — fail loudly.

10. **PL/Tcl trusted mode is even more restrictive than PL/Perl.** Safe Tcl's command set is small and many idioms a Tcl developer expects (file I/O, `package require Tcl 8.6`) simply do not work. If you're considering `pltcl`, prototype the body against the trusted runtime *first*; jumping to `pltclu` to make a stray `package require` succeed is the wrong escape hatch.

11. **Returning rows from a SETOF PL function: data type must match exactly.** PL/Python returns `dict`s keyed by column name; PL/Perl returns hashrefs keyed by column name; PL/Tcl returns lists matching the column order. Misalignment between body and `RETURNS TABLE(...)` produces a runtime error, not a parse error.

12. **Custom function bodies are stored as `text` in `pg_proc.prosrc`** regardless of language. `pg_dump` round-trips them as text. Editing them in place via `CREATE OR REPLACE FUNCTION` will invalidate cached plans across backends only after `DISCARD PLANS` or the next plan cache miss — same caveat as [06-functions.md](./06-functions.md#alter-and-replace).

13. **Triggers in an untrusted PL look like a fast way to add side effects, but they punch a hole through the trust model.** A row insert on a table can fire an `AFTER INSERT` trigger that runs `plpython3u` code with the *trigger owner's* privileges (which is typically a superuser, because that's who installed the language). Audit every trigger that uses an untrusted PL.

14. **Subtransactions in PL bodies stress `pg_subtrans`** the same way `EXCEPTION` blocks in PL/pgSQL do. `plpy.subtransaction()`, PL/Perl `eval { ... }; spi_rollback`, PL/Tcl `catch { ... }`, PL/v8 `plv8.subtransaction()` — all of these consume XIDs and contribute to subtrans SLRU pressure. Don't put them in tight loops. See [08-plpgsql.md](./08-plpgsql.md#exception-handling-and-subtransactions) for the same gotcha in PL/pgSQL.

15. **No way to share types between PLs without going through SQL.** If a PL/Python body returns a Python `dict`, it is serialised through Postgres's wire types into the SQL row; PL/Perl on the other side sees a hashref it built from scratch. There is no shared in-process object.

16. **`elog`/`plpy.error`/`spi_rollback` semantics vary slightly.** PL/Python's `plpy.error(...)` raises a Python exception that becomes an SQL error if not caught. `plpy.fatal(...)` terminates the session. PL/Perl `elog(ERROR, ...)` raises; `croak ...` is also caught. Read the chapter for the PL you are using — the words "error" and "fatal" do *not* mean the same thing across languages.

## See Also

- [06-functions.md](./06-functions.md) — `CREATE FUNCTION` grammar, volatility, parallel safety, `SECURITY DEFINER` hardening. Read first if you are about to write *any* function body, in *any* PL.
- [07-procedures.md](./07-procedures.md) — `CREATE PROCEDURE` and transaction control. Every PL except PL/pgSQL needs to use its own SPI calls to commit/rollback (`plpy.commit()`, `spi_commit`, etc.) — same restrictions as PL/pgSQL procedures (no transaction control inside `SECURITY DEFINER`, etc.).
- [08-plpgsql.md](./08-plpgsql.md) — PL/pgSQL deep reference. The default choice.
- [10-dynamic-sql.md](./10-dynamic-sql.md) — Dynamic SQL and `quote_ident`/`quote_literal`. The SQL-injection-prevention discipline applies identically in every PL.
- [13-cursors-and-prepares.md](./13-cursors-and-prepares.md) — Prepared plans, plan caching, generic vs custom plans. Applies to `plpy.prepare`, `spi_prepare`, and `plv8.prepare`.
- [39-triggers.md](./39-triggers.md) — Trigger function semantics. PL/Python, PL/Perl, and PL/v8 trigger bodies receive the row via `TD`, `$_TD`, and `TG_*` respectively.
- [46-roles-privileges.md](./46-roles-privileges.md) — `USAGE` on a language, `GRANT EXECUTE` on a function, default privileges. Trusted PLs grant `USAGE` to `PUBLIC` by default.[^createlang-usage]
- [47-row-level-security.md](./47-row-level-security.md) — OS-level access from untrusted PLs bypasses RLS policies.
- [53-server-configuration.md](./53-server-configuration.md) — `shared_preload_libraries` required for PL/v8 and some other out-of-tree PLs.
- [64-system-catalogs.md](./64-system-catalogs.md) — `pg_language`, `pg_proc.prolang`, `pg_extension`. The audit queries above join these catalogs.
- [69-extensions.md](./69-extensions.md) — `CREATE EXTENSION`, the `trusted = true` control-file flag,[^ext-trusted] and how to inventory installed extensions.
- [72-extension-development.md](./72-extension-development.md) — Writing your own PL handler (rare, but the link from "what is a language" to "what is a handler" lives there).
- [80-connection-pooling.md](./80-connection-pooling.md) and [81-pgbouncer.md](./81-pgbouncer.md) — Pool-mode interactions with per-backend PL state (`SD`/`GD`/`$_SHARED`/V8 isolate).
- [101-managed-vs-baremetal.md](./101-managed-vs-baremetal.md) — Categorical limitations of managed environments; "untrusted PLs typically disabled" is one of the bullets.

## Sources

[^xplang]: PostgreSQL 16 — Chapter 42 "Procedural Languages". Quote: *"There are currently four procedural languages available in the standard PostgreSQL distribution: PL/pgSQL (Chapter 43), PL/Tcl (Chapter 44), PL/Perl (Chapter 45), and PL/Python (Chapter 46)."* https://www.postgresql.org/docs/16/xplang.html

[^createlang-trusted]: PostgreSQL 16 — `CREATE LANGUAGE`. Quote: *"`TRUSTED` specifies that the language does not grant access to data that the user would not otherwise have."* https://www.postgresql.org/docs/16/sql-createlanguage.html

[^createlang-usage]: PostgreSQL 16 — `CREATE LANGUAGE`. Quote: *"By default, `USAGE` is granted to `PUBLIC` (i.e., everyone) for trusted languages. This can be revoked if desired."* https://www.postgresql.org/docs/16/sql-createlanguage.html

[^createlang-superuser]: PostgreSQL 16 — `CREATE LANGUAGE`. Quote: *"One must have the PostgreSQL superuser privilege to register a new language or change an existing language's parameters."* and *"once the language is created it is valid to assign ownership of it to a non-superuser, who may then drop it, change its permissions, rename it, or assign it to a new owner."* https://www.postgresql.org/docs/16/sql-createlanguage.html

[^plpython-untrusted]: PostgreSQL 16 — Chapter 46 "PL/Python — Python Procedural Language". Quote: *"PL/Python is only available as an 'untrusted' language, meaning it does not offer any way of restricting what users can do in it and is therefore named `plpython3u`. A trusted variant `plpython` might become available in the future if a secure execution mechanism is developed in Python."* https://www.postgresql.org/docs/16/plpython.html

[^plperl-trusted]: PostgreSQL 16 — Section 45.5 "Trusted and Untrusted PL/Perl". Quote: *"In general, the operations that are restricted are those that interact with the environment. This includes file handle operations, `require`, and `use` (for external modules)."* and *"The creation of this function will fail as its use of a forbidden operation will be caught by the validator."* https://www.postgresql.org/docs/16/plperl-trusted.html

[^pltcl-overview]: PostgreSQL 16 — Section 44.1 "PL/Tcl Overview". Quote: *"Everything is executed from within the safety of the context of a Tcl interpreter… Thus, unprivileged database users can be trusted to use this language; it does not give them unlimited authority."* and *"Only a few commands are available to access the database via SPI and to raise messages via `elog()`. PL/Tcl provides no way to access internals of the database server or to gain OS-level access under the permissions of the PostgreSQL server process."* and *"If PL/TclU is used, it must be installed as an untrusted procedural language so that only database superusers can create functions in it."* https://www.postgresql.org/docs/16/pltcl-overview.html

[^pg13-trusted-ext]: PostgreSQL 13 Release Notes. Quote: *"Allow extensions to be specified as trusted (Tom Lane). Such extensions can be installed in a database by users with database-level CREATE privileges, even if they are not superusers. This change also removes the `pg_pltemplate` system catalog."* https://www.postgresql.org/docs/release/13.0/

[^pg13-py25]: PostgreSQL 13 Release Notes. Quote: *"Remove support for Python versions 2.5.X and earlier (Peter Eisentraut)."* https://www.postgresql.org/docs/release/13.0/

[^ext-trusted]: PostgreSQL 16 — Section 38.17.1 "Extension Files", `trusted` control-file parameter. Quote: *"This parameter, if set to true (which is not the default), allows some non-superusers to install an extension that has superuser set to true. Specifically, installation will be permitted for anyone who has CREATE privilege on the current database."* and *"When the user executing `CREATE EXTENSION` is not a superuser but is allowed to install by virtue of this parameter, then the installation or update script is run as the bootstrap superuser, not as the calling user."* https://www.postgresql.org/docs/16/extend-extensions.html

[^pg14-out]: PostgreSQL 14 Release Notes. Quote: *"Allow procedures to have OUT parameters (Peter Eisentraut)."* https://www.postgresql.org/docs/release/14.0/

[^pg18-uuidv7]: PostgreSQL 18 release announcement. Quote (paraphrasing the feature list): *"PG18 adds in-core uuidv7() for time-ordered UUIDs."* https://www.postgresql.org/about/news/postgresql-18-released-3142/

[^plv8]: PL/v8 — JavaScript procedural language for PostgreSQL. Quote: *"PLV8 is a shared library that provides a PostgreSQL procedural language powered by V8 Javascript Engine."* https://github.com/plv8/plv8

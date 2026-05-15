# UUID, Numeric, and Money

Three PostgreSQL types with sharp edges: `uuid` (which version? where do you generate it? does it kill your index?), `numeric` (precision/scale semantics, NaN/Infinity, when it's the right tool vs when `double precision` is), and `money` (almost never the right answer — this file says why and offers two replacements). Plus the canonical deep-dive on `serial` vs `GENERATED ... AS IDENTITY` for surrogate keys, including the macro expansion `serial` actually compiles to, the `ALWAYS`/`BY DEFAULT` decision, and the PG17 partitioned-table identity-column change.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Type Selection Matrix](#type-selection-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
  - [UUID Type](#uuid-type)
  - [UUID Generation in Core](#uuid-generation-in-core)
  - [UUID Extraction Functions (PG17+)](#uuid-extraction-functions-pg17)
  - [uuid-ossp Extension](#uuid-ossp-extension)
  - [Numeric and Decimal](#numeric-and-decimal)
  - [NaN and Infinity in `numeric`](#nan-and-infinity-in-numeric)
  - [Money Type (Avoid)](#money-type-avoid)
  - [Serial vs IDENTITY](#serial-vs-identity)
  - [IDENTITY: `ALWAYS` vs `BY DEFAULT`](#identity-always-vs-by-default)
  - [IDENTITY on Partitioned Tables (PG17+)](#identity-on-partitioned-tables-pg17)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Load this file when:

- Picking a primary-key strategy: integer IDENTITY vs UUIDv4 vs UUIDv7 vs ULID.
- Diagnosing a "B-tree primary key bloats and inserts get slower over time" issue — almost always random UUID PKs.
- Choosing between `numeric(p, s)` and `double precision` for a column that holds measurements, money, or scientific data.
- Migrating off the `money` type (or trying to figure out why a dump won't restore — `lc_monetary` mismatch).
- Migrating off `serial` to `IDENTITY` for a new application or to satisfy a SQL-standard auditor.
- Designing audit columns that surface the `created_at` portion of a UUID (PG17+ `uuid_extract_timestamp`, PG18+ `uuidv7()`).

For the broader scalar-type catalog (text, int, bool, bytea, inet, bit), see [`14-data-types-builtin.md`](./14-data-types-builtin.md). For composite/domain/ENUM/range types, see [`15-data-types-custom.md`](./15-data-types-custom.md). For `timestamptz` and time arithmetic, see [`19-timestamp-timezones.md`](./19-timestamp-timezones.md).

## Mental Model

Five rules drive every decision in this file:

1. **UUID is 16 bytes, always.** It's not "longer than `bigint`" by much, and the conventional wisdom that "UUIDs cost too much disk" is overstated — they cost about 2× a `bigint` in the heap. The real cost is **index-write amplification** when UUIDv4 is the leftmost B-tree key, because random keys produce random page hits.
2. **Use UUIDv7 (PG18+) when the UUID is the PK or any B-tree leading column.** It is time-ordered, so inserts append to the right edge of the index instead of scattering. For pre-PG18 deployments, install the `pg_uuidv7` extension or implement v7 in userland.

> [!WARNING]
> Do not use `gen_random_uuid()` (UUIDv4) as a high-cardinality leading B-tree key. Random inserts scatter writes across the entire index, causing page splits and cache eviction at scale. See [Gotcha #1](#gotchas--anti-patterns).
3. **`numeric` for exact, `double precision` for fast, `real` almost never.** Use `numeric(p, s)` for money, decimal measurements, and anything where rounding error must be zero. Use `double precision` for science and aggregate statistics. Never use `real` (single-precision float) for new code — the storage savings are tiny and the precision loss is severe.
4. **Do not use the `money` type.** It is locale-sensitive (`lc_monetary`) at output, has exactly two fractional digits hard-coded by the locale, and silently breaks at `pg_restore` if the destination database has a different `lc_monetary`. Use `numeric(12, 2)` (or `numeric(N, S)` matching your currency precision) or an integer-minor-units column with the currency tracked separately.
5. **Use `GENERATED ... AS IDENTITY` for surrogate keys on new tables, not `serial`.** `serial` is a PostgreSQL-only macro that desugars to a `CREATE SEQUENCE` + `DEFAULT nextval(...)` + `ALTER SEQUENCE ... OWNED BY`. `IDENTITY` is SQL-standard, doesn't have the dump-permission and ownership-confusion problems of `serial`, and works on partitioned tables since PG17.

## Type Selection Matrix

| You need... | Use | Avoid | Why |
|---|---|---|---|
| Opaque application-visible ID with no temporal info | `uuid` + `gen_random_uuid()` (v4) | `bigint` IDENTITY (predictable) | Random UUIDs leak nothing about row order or insertion time |
| Time-ordered surrogate key (PG18+) | `uuid` + `uuidv7()` | `gen_random_uuid()` as PK | UUIDv7 is K-sortable; v4 randomness destroys B-tree insert locality |
| Time-ordered surrogate key (PG≤17) | `bigint` IDENTITY, or `uuid` from `pg_uuidv7` extension | `gen_random_uuid()` as PK | See gotcha #1 below |
| Compact internal-only PK | `bigint` `GENERATED BY DEFAULT AS IDENTITY` | `serial` | IDENTITY is SQL-standard and avoids serial's ownership pitfalls |
| Small lookup-table PK | `int` IDENTITY | `bigint` | An `int` PK still holds 2.1 billion rows |
| Exact decimal arithmetic (money, billing, scientific) | `numeric(p, s)` | `double precision` | Floats accumulate error; `0.1 + 0.2 ≠ 0.3` |
| Floating-point aggregate (mean, variance, distance) | `double precision` | `numeric` | Numeric is 10–100× slower; floats are fine when you tolerate ULPs |
| Multi-currency money | `numeric(N, S)` + a `currency_code char(3)` column, or integer minor units + currency | `money` type | `money` is locale-dependent, single fractional scale, and silently mis-restores |
| Single-currency app money | `numeric(12, 2)` | `money` type, `double precision` | Exact, dump-portable, no locale dependency |
| Bit-flag set up to 64 flags | `bigint` + bitwise ops | `bit(N)` or many booleans | One bigint = 64 flags + GIN/btree indexable; see [`14-data-types-builtin.md`](./14-data-types-builtin.md) |
| Distributed ID generation (no central coordinator) | UUIDv7 (PG18+) or app-side ULID stored as `uuid` | `serial`/`IDENTITY` (per-cluster coordinator) | Sequences need a single primary; UUIDs don't |
| Cross-system event/message ID | `uuid` (any version that matches the producer) | `bigint` (collides across systems) | UUID is the universal exchange format |

## Syntax / Mechanics

### UUID Type

`uuid` stores 128-bit values as defined by RFC 4122 / RFC 9562, in 16 bytes.[^uuid-type] The canonical textual form is *"a sequence of lower-case hexadecimal digits, in several groups separated by hyphens, specifically a group of 8 digits followed by three groups of 4 digits followed by a group of 12 digits, for a total of 32 digits representing the 128 bits."*[^uuid-type]

Accepted input forms (output is always the canonical lowercase-hyphenated form)[^uuid-type]:

    -- All five of these store the same value
    SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid;
    SELECT 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid;
    SELECT '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}'::uuid;
    SELECT 'a0eebc999c0b4ef8bb6d6bb9bd380a11'::uuid;
    SELECT 'a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11'::uuid;

The B-tree operator class supports `=`, `<>`, `<`, `<=`, `>`, `>=` — UUIDs sort lexicographically by their byte representation.

### UUID Generation in Core

PostgreSQL ships UUID generators in core. The catalog has shifted across versions:

| Function | Version | Returns | Notes |
|---|---|---|---|
| `gen_random_uuid()` | PG13+ in core | UUIDv4 | Moved from `pgcrypto`/`uuid-ossp` to core in PG13[^pg13-genrand] |
| `uuidv4()` | PG18+ | UUIDv4 | Alias for `gen_random_uuid()`[^pg18-uuid] |
| `uuidv7([shift interval])` | PG18+ | UUIDv7 (time-ordered) | Optional `shift` offsets the embedded timestamp[^pg18-uuid] |

> [!NOTE] PostgreSQL 13
>
> `gen_random_uuid()` moved into core. The PG13 release notes: *"Add function `gen_random_uuid()` to generate version-4 UUIDs. Previously UUID generation functions were only available in the external modules uuid-ossp and pgcrypto."*[^pg13-genrand]

> [!NOTE] PostgreSQL 18
>
> Adds `uuidv7()` and the `uuidv4()` alias: *"Add UUID version 7 generation function `uuidv7()`. This UUID value is temporally sortable. Function alias `uuidv4()` has been added to explicitly generate version 4 UUIDs."*[^pg18-uuid] `uuidv7()` uses millisecond UNIX timestamp + sub-millisecond timestamp + random; the optional `interval` argument shifts the embedded timestamp (useful for backfilling).

Example:

    -- PG13+ (random, no time component)
    SELECT gen_random_uuid();
    -- 5b30857f-0bfa-48b5-ac0b-5c64e28078d1

    -- PG18+ (time-ordered, sortable by creation time within the same millisecond)
    SELECT uuidv7();
    -- 019535d9-3df7-79fb-b466-fa907fa17f9e

    -- PG18+ (shift timestamp 1 hour into the past)
    SELECT uuidv7(shift => '-1 hour');

### UUID Extraction Functions (PG17+)

> [!NOTE] PostgreSQL 17
>
> Adds `uuid_extract_timestamp()` and `uuid_extract_version()`: *"Add functions `uuid_extract_timestamp()` and `uuid_extract_version()` to return UUID information."*[^pg17-uuid-extract]

| Function | Returns | Behavior |
|---|---|---|
| `uuid_extract_version(uuid)` | `smallint` | RFC 9562 version digit (1, 4, 7, ...); NULL for non-RFC-9562 variants[^pg18-uuid-funcs] |
| `uuid_extract_timestamp(uuid)` | `timestamptz` | Embedded timestamp for v1 and v7; NULL for other versions[^pg18-uuid-funcs] |

Example:

    SELECT uuid_extract_version('41db1265-8bc1-4ab3-992f-885799a4af1d'::uuid);
    -- 4

    SELECT uuid_extract_timestamp('019535d9-3df7-79fb-b466-fa907fa17f9e'::uuid);
    -- 2025-02-23 21:46:24.503-05

Caveat from the docs: *"the extracted timestamp is not necessarily exactly equal to the time the UUID was generated; this depends on the implementation that generated the UUID."*[^pg18-uuid-funcs]

### uuid-ossp Extension

The `uuid-ossp` extension is *"only necessary for special requirements beyond what is available in core"*[^uuid-ossp] — specifically when you need v1 (MAC + timestamp), v3 (MD5 namespace), or v5 (SHA-1 namespace) UUIDs.

| Function | What it does |
|---|---|
| `uuid_generate_v1()` | v1 from MAC address + timestamp (reveals identity and time)[^uuid-ossp] |
| `uuid_generate_v1mc()` | v1 with random multicast MAC, hiding the real MAC[^uuid-ossp] |
| `uuid_generate_v3(namespace, name)` | v3, deterministic MD5 hash of namespace+name[^uuid-ossp] |
| `uuid_generate_v4()` | v4, random — equivalent to core `gen_random_uuid()`[^uuid-ossp] |
| `uuid_generate_v5(namespace, name)` | v5, deterministic SHA-1 hash; preferred over v3[^uuid-ossp] |

`uuid_nil()`, `uuid_ns_dns()`, `uuid_ns_url()`, `uuid_ns_oid()`, `uuid_ns_x500()` return well-known namespace constants for use with v3/v5.[^uuid-ossp]

The extension is marked **trusted** (PG13+), so a non-superuser with `CREATE` privilege on the database can install it:

    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

**Recommendation:** Use core `gen_random_uuid()` (v4) or `uuidv7()` (v7, PG18+) for ID generation. Reach for `uuid-ossp` only when you genuinely need deterministic (v3/v5) UUIDs — for example, to derive a stable UUID from a tenant ID + an external system ID.

### Numeric and Decimal

`numeric` and `decimal` are the same type[^numeric] — arbitrary-precision exact decimal. Three declaration forms:

    NUMERIC(precision, scale)   -- explicit
    NUMERIC(precision)          -- scale defaults to 0
    NUMERIC                     -- unconstrained ("any precision, any scale")

Quoting the docs: *"The precision of a numeric is the total count of significant digits in the whole number, that is, the number of digits to both sides of the decimal point. The scale of a numeric is the count of decimal digits in the fractional part, to the right of the decimal point."*[^numeric]

The maximum explicitly-specifiable precision is **1000**[^numeric]. An unconstrained `numeric` column can store *"up to 131072 digits before the decimal point; up to 16383 digits after the decimal point."*[^numeric]

| Column declaration | Stores | Notes |
|---|---|---|
| `numeric(12, 2)` | up to 9_999_999_999.99 | Standard for single-currency money |
| `numeric(18, 6)` | up to 999_999_999_999.999999 | Standard for FX/crypto rates |
| `numeric(p, 0)` | integers up to 10^p | Why? Use `bigint`/`int` instead unless `p > 19` |
| `numeric` (unconstrained) | anything up to docs limits | Slower; planner can't bound output width |

> [!NOTE] PostgreSQL 15
>
> Scale can now be negative or greater than precision: *"Allow the scale of a numeric value to be negative, or greater than its precision. This allows rounding of values to the left of the decimal point, e.g., `'1234'::numeric(4, -2)` returns 1200."*[^pg15-negscale]

> [!NOTE] PostgreSQL 18
>
> *"Add functions `gamma()` and `lgamma()`."* `numeric` multiplication and division are also faster in PG18.[^pg18-numeric]

### NaN and Infinity in `numeric`

`numeric` supports `NaN`, but its ordering is non-IEEE: *"PostgreSQL treats NaN values as equal, and greater than all non-NaN values."*[^numeric-nan] This is required so `numeric` can be sorted and indexed in B-trees — the standard "NaN is not equal to NaN, sort order undefined" rule would break ordering.

> [!NOTE] PostgreSQL 14
>
> `numeric` supports `Infinity` and `-Infinity`: *"Add support for Infinity and -Infinity values in the numeric data type. Floating-point data types already supported these."*[^pg14-numinf]

Implication: when you sort by a `numeric` column with potentially-bad values, `NaN` ends up *after* all real numbers and after `Infinity`. Use a `WHERE` filter to exclude `NaN`/`Infinity` if your output should be finite.

### Money Type (Avoid)

`money` is 8 bytes and stores a fixed-point fractional amount. Its **fractional scale is determined by `lc_monetary`** at the database level. The range *(assuming two fractional digits)* is `-92233720368547758.08 to +92233720368547758.07`.

The docs themselves warn[^money]:

> *"Since the output of this data type is locale-sensitive, it might not work to load `money` data into a database that has a different setting of `lc_monetary`. To avoid problems, before restoring a dump into a new database make sure `lc_monetary` has the same or equivalent value as in the database that was dumped."*

The same page also says[^money]: *"Floating point numbers should not be used to handle money due to the potential for rounding errors."*

> [!WARNING] Do not use `money` for new tables
>
> The `money` type has three irreparable design problems for application code:
>
> 1. **Locale-dependent output** — the displayed currency symbol, thousands separator, and decimal mark come from `lc_monetary`. A query result that prints `$1,000.00` on one cluster prints `1.000,00 €` on another.
> 2. **Single hard-coded scale per cluster.** You cannot have one column for USD (2 decimals) and another for BHD (3 decimals) — they all share `lc_monetary`'s scale.
> 3. **`pg_restore` quietly mis-restores across `lc_monetary` boundaries.** The dump emits the locale-formatted text; restoring into a different locale parses the text differently.
>
> **Replacement A — single-currency app:** `numeric(12, 2)` (or `numeric(N, S)` matching your currency precision). Exact, fast, dump-portable, locale-independent.
>
> **Replacement B — multi-currency app:** integer minor units (`bigint` cents) + a `currency_code char(3)` column. Same recipe as Stripe, PayPal, ledger systems. Avoids floating-point and avoids per-currency scale mismatches entirely. Convert to display at the UI layer.

To convert an existing `money` column to `numeric` losslessly[^money]: `SELECT '52093.89'::money::numeric;` — `money::numeric` is documented as lossless; other casts can lose precision and require staging through `numeric`.

### Serial vs IDENTITY

`serial`, `bigserial`, and `smallserial` are **macros, not real types**. The docs show the expansion[^serial]:

    -- This declaration:
    CREATE TABLE t (id SERIAL);

    -- expands to:
    CREATE SEQUENCE t_id_seq AS integer;
    CREATE TABLE t (
        id integer NOT NULL DEFAULT nextval('t_id_seq')
    );
    ALTER SEQUENCE t_id_seq OWNED BY t.id;

Type aliases[^serial]:

| Alias | Underlying type | Range |
|---|---|---|
| `smallserial` / `serial2` | `smallint` | 1 to 32,767 |
| `serial` / `serial4` | `integer` | 1 to 2,147,483,647 |
| `bigserial` / `serial8` | `bigint` | 1 to 9,223,372,036,854,775,807 |

The docs also flag the gap caveat[^serial]: *"Because smallserial, serial and bigserial are implemented using sequences, there may be 'holes' or gaps in the sequence of values which appears in the column, even if no rows are ever deleted."*

`IDENTITY` is the SQL-standard replacement, recommended for all new code[^serial]: *"Another way is to use the SQL-standard identity column feature, described at CREATE TABLE."*

Why prefer `IDENTITY` over `serial`:

- **It's a real column property, not a triggers-plus-sequence implementation hack.** The sequence is owned by the column and `DROP TABLE` cleans it up unambiguously; with `serial`, the `ALTER SEQUENCE ... OWNED BY` link is what creates that cleanup, and migrations sometimes break it.
- **SQL-standard syntax.** Easier to migrate to/from other databases that support `GENERATED AS IDENTITY`.
- **`ALWAYS` mode** can prevent user-supplied values from clobbering the sequence — there is no equivalent for `serial`.
- **No `serial` permission confusion.** `serial` requires `USAGE` on the underlying sequence to insert, surprising application roles that have INSERT on the table but not USAGE on the auto-created sequence.
- **Works on partitioned tables (PG17+).** `serial` cannot be used on partitioned-table parents.

### IDENTITY: `ALWAYS` vs `BY DEFAULT`

The grammar[^identity]:

    column_name TYPE GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [ ( sequence_options ) ]

The two modes differ only in how user-supplied values are handled[^identity]:

- **`ALWAYS`**: *"a user-specified value is only accepted if the INSERT statement specifies OVERRIDING SYSTEM VALUE."* In `UPDATE`, *"any update of the column to any value other than DEFAULT will be rejected."*
- **`BY DEFAULT`**: *"the user-specified value takes precedence."* `UPDATE` accepts any value.

**Decision rule:**

- Use **`GENERATED BY DEFAULT AS IDENTITY`** for ordinary surrogate keys. It behaves like `serial` for application code: if the INSERT omits the column, the sequence assigns; if it provides a value, that value is used.
- Use **`GENERATED ALWAYS AS IDENTITY`** when you want to *prevent* application code from supplying a value (e.g., to force the sequence to be the authority and catch bugs where an old export script tries to set the ID manually). Loading data from a dump that contains explicit IDs then requires `INSERT ... OVERRIDING SYSTEM VALUE`.

`sequence_options` can override `START`, `INCREMENT`, `MINVALUE`, `MAXVALUE`, `CACHE`, `CYCLE`, plus IDENTITY-specific options `SEQUENCE NAME name`, `LOGGED`, `UNLOGGED`[^identity]:

    -- Custom sequence name and start value
    CREATE TABLE invoices (
        id bigint GENERATED BY DEFAULT AS IDENTITY
            (SEQUENCE NAME invoices_id_seq START 1000000),
        ...
    );

### IDENTITY on Partitioned Tables (PG17+)

> [!NOTE] PostgreSQL 17
>
> *"Allow partitioned tables to have identity columns."*[^pg17-identity-part] Before PG17, you had to attach a sequence default manually to each partition; PG17 makes `IDENTITY` work on the partitioned parent and have new partitions inherit it correctly.

    -- PG17+: partitioned parent with an identity column
    CREATE TABLE events (
        id        bigint GENERATED BY DEFAULT AS IDENTITY,
        ts        timestamptz NOT NULL,
        payload   jsonb,
        PRIMARY KEY (id, ts)
    ) PARTITION BY RANGE (ts);

For pre-PG17 partitioned tables you must use a single sequence + per-partition default or accept globally-unique UUIDs as the PK.

## Examples / Recipes

### Recipe 1 — UUIDv4 as opaque application ID (default for non-PK exposure)

When the UUID is exposed to clients but the **B-tree PK is a separate `bigint`**, UUIDv4 is fine. Insertion locality doesn't matter because the UUID is in a secondary B-tree where you query by exact equality.

    CREATE TABLE users (
        id           bigint  GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        public_id    uuid    NOT NULL DEFAULT gen_random_uuid() UNIQUE,
        email        text    NOT NULL UNIQUE,
        created_at   timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX users_public_id_idx ON users (public_id);

`public_id` is what the API returns. The internal `id` stays compact and append-only for join and FK efficiency.

### Recipe 2 — UUIDv7 as the PK (PG18+)

When the UUID **is** the PK (microservices, cross-system events, distributed inserts), use `uuidv7()` for K-sortable insertion locality.

    -- Requires PG18
    CREATE TABLE orders (
        id          uuid     NOT NULL DEFAULT uuidv7() PRIMARY KEY,
        customer_id bigint   NOT NULL,
        total_cents bigint   NOT NULL,
        currency    char(3)  NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
    );

UUIDv7 inserts are append-mostly at the right edge of the index, the same locality pattern as a `bigint` IDENTITY PK. You also get a free K-sortable column: `ORDER BY id` is approximately `ORDER BY created_at` to millisecond precision.

### Recipe 3 — Pre-PG18 UUIDv7 alternative

Two options without PG18:

**Option A — `pg_uuidv7` extension** (third-party; check it's allowed in your environment): install the extension and use its `uuid_generate_v7()` function in the column default.

**Option B — userland SQL function** (no extension required, but slightly slower than the C implementation):

    CREATE OR REPLACE FUNCTION app.uuidv7() RETURNS uuid
        LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
        SELECT encode(
            set_bit(
                set_bit(
                    overlay(uuid_send(gen_random_uuid())
                        PLACING substring(int8send(
                            (extract(epoch from clock_timestamp()) * 1000)::bigint
                        ) from 3) FROM 1 FOR 6),
                    52, 1),
                53, 1)::uuid::text::bytea, 'hex'
        )::uuid;
    $$;

    -- Use as column default
    CREATE TABLE events (
        id  uuid NOT NULL DEFAULT app.uuidv7() PRIMARY KEY,
        ...
    );

Verify the version byte by `uuid_extract_version()` (PG17+) before relying on the encoding.

### Recipe 4 — Single-currency money

    CREATE TABLE invoice_lines (
        id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        invoice_id  bigint NOT NULL REFERENCES invoices(id),
        description text   NOT NULL,
        amount      numeric(12, 2) NOT NULL CHECK (amount >= 0)
    );

`numeric(12, 2)` holds amounts up to 9,999,999,999.99 — sufficient for line items in essentially any currency. The `CHECK` keeps the column non-negative at write time. The CHECK on the column type, not the data type, is intentional — the type itself enforces range, the CHECK enforces business rule.

### Recipe 5 — Multi-currency: integer minor units

    CREATE TABLE charges (
        id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        amount_minor  bigint   NOT NULL,
        currency      char(3)  NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        created_at    timestamptz NOT NULL DEFAULT now()
    );

    -- $42.50 USD
    INSERT INTO charges (amount_minor, currency) VALUES (4250, 'USD');
    -- 100 JPY (JPY has 0 decimals)
    INSERT INTO charges (amount_minor, currency) VALUES (100, 'JPY');
    -- 1.234 BHD (BHD has 3 decimals)
    INSERT INTO charges (amount_minor, currency) VALUES (1234, 'BHD');

Display logic at the application layer knows each currency's exponent and formats accordingly. No floating-point error, no locale dependency, dump-portable.

### Recipe 6 — Exact arithmetic with `numeric` vs silent error with `double precision`

    -- Float arithmetic accumulates error:
    SELECT 0.1::double precision + 0.2::double precision;
    -- 0.30000000000000004

    -- numeric is exact:
    SELECT 0.1::numeric + 0.2::numeric;
    -- 0.3

    -- A more painful version: sum 1000 small payments
    SELECT sum(0.01::double precision) FROM generate_series(1, 1000);
    -- 9.999999999999831  -- off by ~2e-13

    SELECT sum(0.01::numeric)         FROM generate_series(1, 1000);
    -- 10.00              -- exact

### Recipe 7 — PG15 negative scale rounding

    -- Round to the nearest 100 at INSERT
    CREATE TABLE rounded_prices (
        amount_dollars numeric(8, -2)
    );
    -- '1234'::numeric(8, -2) stores 1200

    -- Or round on demand
    SELECT '1234'::numeric(4, -2);
    -- 1200

This avoids a per-row `round(amount, -2)` call and is checked at write time.

### Recipe 8 — NaN- and Infinity-safe sorting

    -- NaN sorts AFTER Infinity in numeric, which is rarely what you want
    SELECT v FROM (VALUES
        (1.0::numeric), ('Infinity'::numeric), ('NaN'::numeric), (2.0::numeric)
    ) AS t(v)
    ORDER BY v;
    --      v
    -- ----------
    --        1.0
    --        2.0
    --  Infinity
    --       NaN

    -- Filter out non-finite values before user-facing display:
    SELECT v FROM (VALUES
        (1.0::numeric), ('Infinity'::numeric), ('NaN'::numeric), (2.0::numeric)
    ) AS t(v)
    WHERE v != 'NaN'::numeric AND v != 'Infinity'::numeric AND v != '-Infinity'::numeric
    ORDER BY v;

### Recipe 9 — IDENTITY column creation, both modes

    -- BY DEFAULT — application can supply a value if needed
    CREATE TABLE accounts (
        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        ...
    );
    INSERT INTO accounts DEFAULT VALUES;                    -- sequence assigns
    INSERT INTO accounts (id) VALUES (42);                  -- ID = 42 used

    -- ALWAYS — application is locked out of the column
    CREATE TABLE invoices (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ...
    );
    INSERT INTO invoices DEFAULT VALUES;                    -- OK
    INSERT INTO invoices (id) VALUES (42);
    -- ERROR: cannot insert into column "id"
    -- HINT: Column "id" is an identity column defined as GENERATED ALWAYS.
    -- To override, use OVERRIDING SYSTEM VALUE in the INSERT.

    INSERT INTO invoices (id) OVERRIDING SYSTEM VALUE VALUES (42);  -- now OK

### Recipe 10 — Adding IDENTITY to an existing column

This is the canonical online migration when you cannot drop and recreate the table.

    -- Existing table with an integer PK populated manually
    BEGIN;

    -- 1. Convert column to identity. Required: column must already be NOT NULL.
    ALTER TABLE legacy_orders
        ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;

    -- 2. Sync the sequence so the next nextval > max(id).
    SELECT setval(
        pg_get_serial_sequence('legacy_orders', 'id'),
        (SELECT coalesce(max(id), 0) FROM legacy_orders),
        true   -- next nextval returns max+1
    );

    COMMIT;

The serial-to-IDENTITY migration recipe (drop the old DEFAULT, then ADD GENERATED, then `setval`) is documented in [`14-data-types-builtin.md`](./14-data-types-builtin.md) Recipe 2.

### Recipe 11 — IDENTITY on a partitioned table (PG17+)

    -- Requires PG17
    CREATE TABLE events (
        id      bigint GENERATED BY DEFAULT AS IDENTITY,
        ts      timestamptz NOT NULL,
        kind    text NOT NULL,
        payload jsonb,
        PRIMARY KEY (id, ts)
    ) PARTITION BY RANGE (ts);

    CREATE TABLE events_2026_01 PARTITION OF events
        FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

    INSERT INTO events (ts, kind, payload)
    VALUES (now(), 'signup', '{"plan":"pro"}'::jsonb);
    -- id is assigned from the parent's identity sequence

Before PG17 this required attaching `DEFAULT nextval('shared_seq')` to every partition individually.

### Recipe 12 — Extract creation time from a UUIDv7 (PG17+ extractors, PG18+ generator)

    -- PG18+: store v7, query the time later
    SELECT id,
           uuid_extract_timestamp(id) AS approx_created_at
    FROM orders
    WHERE uuid_extract_timestamp(id) >= now() - interval '1 day'
    ORDER BY id;

The query is index-friendly because `id` is K-sortable and `uuid_extract_timestamp(id)` is a `STABLE` function. To get a real index scan on the time predicate, either an explicit `created_at` column with its own index (cheaper plan) or a functional index on `uuid_extract_timestamp(id)` works. Prefer the explicit column for query-heavy tables. For `timestamptz` arithmetic on the extracted value, see [`19-timestamp-timezones.md`](./19-timestamp-timezones.md).

### Recipe 13 — Audit for `money` columns (call for migration)

    SELECT n.nspname  AS schema_name,
           c.relname  AS table_name,
           a.attname  AS column_name
    FROM pg_attribute a
    JOIN pg_class    c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type     t ON t.oid = a.atttypid
    WHERE t.typname  = 'money'
      AND c.relkind IN ('r', 'p')    -- tables and partitioned tables
      AND a.attnum   > 0
      AND NOT a.attisdropped
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1, 2, 3;

Every row in the result is a migration candidate. Replace with `numeric(N, S)` (single currency) or integer minor units + a currency column (multi-currency).

### Recipe 14 — Catalog audit: IDENTITY vs serial inventory

    -- Find every IDENTITY column
    SELECT n.nspname  AS schema_name,
           c.relname  AS table_name,
           a.attname  AS column_name,
           CASE a.attidentity
               WHEN 'a' THEN 'ALWAYS'
               WHEN 'd' THEN 'BY DEFAULT'
           END AS identity_mode
    FROM pg_attribute a
    JOIN pg_class    c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE a.attidentity IN ('a', 'd')
      AND c.relkind IN ('r', 'p')
      AND NOT a.attisdropped
    ORDER BY 1, 2, 3;

    -- Find every legacy serial column (nextval default + OWNED BY sequence)
    SELECT n.nspname,
           c.relname,
           a.attname,
           pg_get_expr(d.adbin, d.adrelid) AS column_default
    FROM pg_attribute a
    JOIN pg_attrdef   d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    JOIN pg_class    c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'
      AND a.attidentity = ''                       -- exclude IDENTITY
      AND c.relkind IN ('r', 'p')
      AND NOT a.attisdropped
    ORDER BY 1, 2, 3;

Every row in the second result is a `serial` candidate to migrate to `IDENTITY` (recipe 10).

### Recipe 15 — Bench UUIDv4 vs UUIDv7 vs bigint PK insert locality

A diagnostic, not a recipe to ship — but the easiest way to see the cost of UUIDv4-as-PK on a busy table:

    -- Three identical tables, three PK strategies
    CREATE TABLE bench_bigint (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, payload text);
    CREATE TABLE bench_v4     (id uuid   NOT NULL DEFAULT gen_random_uuid()  PRIMARY KEY, payload text);
    CREATE TABLE bench_v7     (id uuid   NOT NULL DEFAULT uuidv7()           PRIMARY KEY, payload text);  -- PG18+

    -- Insert 1M rows into each, then compare:
    --   pg_total_relation_size('bench_*')
    --   pg_indexes_size('bench_*')
    --   pg_stat_user_tables.n_tup_hot_upd ratio
    --   EXPLAIN (ANALYZE, BUFFERS) on a sample insert batch

The bigint PK and the v7 PK will be similar in size and BUFFERS-dirtied; the v4 PK will be 2–4× larger in index size and have substantially more random page hits per insert.

## Gotchas / Anti-patterns

1. **`gen_random_uuid()` as a high-cardinality leading B-tree key destroys insert locality.** Each insert lands on a random page, blowing the buffer cache and creating page splits across the index. Use `bigint` IDENTITY or PG18+ `uuidv7()` if the UUID is the leading B-tree column. Use v4 happily in secondary indexes where you query by `=`.
2. **`varchar(36)` for UUID instead of the `uuid` type.** Wastes ~2× storage (text serialization vs 16 binary bytes), loses validation, loses the optimized comparison operator, and breaks `uuid_extract_*()`. Always use the `uuid` type.
3. **UUID PK without an index strategy for sorted queries.** If you need `ORDER BY created_at`, you still need a `created_at` column with an index — UUIDv7 sorts by *generation time*, not by any business event time, and `uuid_extract_timestamp()` is a function call that won't use a plain B-tree on `id` for ordering.
4. **`numeric` without precision/scale for performance-sensitive columns.** Unconstrained `numeric` is 10–100× slower than `double precision` and the planner can't bound the column width for hash-partition selection. Use `numeric(p, s)` to constrain the value space whenever you can.
5. **`numeric` for high-volume scientific aggregation.** A `sum(measurements)` over a billion rows is 10–100× faster as `double precision`. Use exact `numeric` for money; use `double precision` for science.
6. **`real` (single-precision float) for new columns.** The storage saving (4 bytes vs 8) is meaningless on modern hardware, and the precision loss is severe — only 6 decimal digits. Use `double precision`.
7. **NaN-equals-NaN in `numeric` causes silent dedup**. `SELECT DISTINCT measurement FROM t` collapses multiple `NaN` values into one because `numeric` treats `NaN = NaN`. If you need IEEE NaN semantics, use `double precision`.
8. **NaN sorts AFTER Infinity in `numeric`.** Top-N queries can return `NaN` rows when you wanted real maxima. Filter `WHERE v != 'NaN'` or `WHERE v = v` (which is false for IEEE NaN but true for PostgreSQL `numeric` NaN — be explicit about which semantic you mean).
9. **`money` type in a multi-database, multi-locale environment.** `lc_monetary` mismatch silently mis-parses `pg_dump` text output at restore time. Replace with `numeric(N, S)` or integer minor units. See recipe 13 for the audit.
10. **`money` for multi-currency apps.** Single hard-coded fractional scale per cluster — no way to handle USD (2 decimals) and BHD (3 decimals) in the same database.
11. **`'$1,234.56'::money` looks portable but isn't.** It parses with the current `lc_monetary`, which means an SQL constant that worked in one cluster fails or mis-parses in another. Use `numeric` everywhere if you need portability.
12. **`serial` column with INSERT-only application role lacking sequence USAGE.** A role with `INSERT` on the table can't actually insert because `nextval(seq)` requires `USAGE` on the sequence. With `IDENTITY`, the privilege model is owned by the column property, not a separate sequence object. Migrate.
13. **`serial` column on the parent of inheritance/partitioned-tables (pre-PG17).** `serial` works on the parent but child partitions don't inherit it; you end up with the parent's sequence ignored by inserts that go through partitions. Use `IDENTITY` (PG17+) or a single shared sequence with explicit `DEFAULT nextval('seq')` on each partition.
14. **`DROP TABLE` leaves an orphan `serial` sequence.** If the sequence's `OWNED BY` link is broken (often by `pg_dump` or migration tools), the sequence survives the `DROP TABLE` and shows up as an "unused" object on next audit. `IDENTITY` sequences are always cleaned up — they are a column property, not a separate object.
15. **`OVERRIDING SYSTEM VALUE` required for `ALWAYS`, easy to forget on dump-restore.** A `pg_dump` of a table with `GENERATED ALWAYS AS IDENTITY` includes `OVERRIDING SYSTEM VALUE` clauses automatically (PG10+); a hand-rolled bulk import script does not. If you see `cannot insert into column "id"` errors during a manual data load, the column is in `ALWAYS` mode.
16. **`setval(seq, max_id)` without the `is_called=true` third argument** sets the *current* value, so the *next* `nextval` returns `max_id` again — producing a UNIQUE-violation on the very next insert. Always pass `setval(seq, max_id, true)` after a bulk import.
17. **`numeric(p, s)` truncates at INSERT silently when the value exceeds scale.** `INSERT INTO t (n) VALUES (1.234)` into `numeric(5, 2)` stores `1.23`, not `1.234`. Only the precision check raises an error; the scale truncates. Apply CHECKs at the column level or validate at the application layer if exact preservation matters.
18. **`uuid_extract_timestamp` returns NULL for v4.** Two reasons: (a) you accidentally wrote `gen_random_uuid()` when you wanted `uuidv7()`, (b) you have legacy v4 IDs from before adopting v7. Recipe 12 only works on v7 (and v1, but you should not be generating v1).
19. **UUIDv7's clock is the server clock, not a logical clock.** If two backends generate UUIDs in the same millisecond and the random tie-breaker collides (astronomically unlikely but theoretically possible), they collide. The 74-bit random component makes this safe in practice. Do not rely on UUIDv7 for cross-machine *ordering* finer than ~1 ms.
20. **Mixing `gen_random_uuid()` and `uuidv7()` in the same B-tree column.** A table that started with v4 PKs and migrated to v7 will have an index whose left half is random and right half is K-sortable. Inserts of v7 land at the right edge (good) but range scans across both halves see the random left half. The cure is a one-time `REINDEX CONCURRENTLY` after the cutover so the B-tree is built fresh in v7 order — though the random v4 IDs still scatter at insert time if you re-insert them.

## See Also

- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — the broader scalar-type catalog and the serial-to-IDENTITY migration recipe.
- [`15-data-types-custom.md`](./15-data-types-custom.md) — composite, domain, ENUM, range; useful for `CREATE DOMAIN positive_money AS numeric(12, 2) CHECK (VALUE >= 0)`.
- [`19-timestamp-timezones.md`](./19-timestamp-timezones.md) — `timestamptz` arithmetic and the `+/-Infinity` interval handling (PG17+).
- [`22-indexes-overview.md`](./22-indexes-overview.md) and [`23-btree-indexes.md`](./23-btree-indexes.md) — why UUIDv4 PK kills insert locality, what HOT update needs, fillfactor tuning.
- [`30-hot-updates.md`](./30-hot-updates.md) — HOT-update prerequisites, including the indexed-column-changed rule.
- [`50-encryption-pgcrypto.md`](./50-encryption-pgcrypto.md) — `pgcrypto` (which used to host `gen_random_uuid()` pre-PG13).
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_attribute.attidentity`, the `'a'/'d'/''` enum used in recipes 13 and 14.
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — when to plan the cutover to PG18 to get `uuidv7()` in core.
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — version-feature index for UUID, IDENTITY, and numeric changes.

## Sources

[^uuid-type]: PostgreSQL 16 — UUID Type. *"The data type uuid stores Universally Unique Identifiers (UUID) as defined by RFC 4122, ISO/IEC 9834-8:2005, and related standards."* *"A UUID is written as a sequence of lower-case hexadecimal digits, in several groups separated by hyphens, specifically a group of 8 digits followed by three groups of 4 digits followed by a group of 12 digits, for a total of 32 digits representing the 128 bits."* *"PostgreSQL also accepts the following alternative forms for input: use of upper-case digits, the standard format surrounded by braces, omitting some or all hyphens, adding a hyphen after any group of four digits."* https://www.postgresql.org/docs/16/datatype-uuid.html

[^uuid-ossp]: PostgreSQL 16 — uuid-ossp. *"This module provides functions to generate universally unique identifiers (UUIDs) … this module is only necessary for special requirements beyond what is available in core PostgreSQL."* The module is trusted; `uuid_generate_v1()`, `uuid_generate_v1mc()`, `uuid_generate_v3(namespace, name)`, `uuid_generate_v4()`, `uuid_generate_v5(namespace, name)`, plus namespace constants `uuid_nil()`/`uuid_ns_dns()`/`uuid_ns_url()`/`uuid_ns_oid()`/`uuid_ns_x500()`. https://www.postgresql.org/docs/16/uuid-ossp.html

[^pg13-genrand]: PostgreSQL 13 Release Notes. *"Add function `gen_random_uuid()` to generate version-4 UUIDs (Peter Eisentraut). Previously UUID generation functions were only available in the external modules uuid-ossp and pgcrypto."* https://www.postgresql.org/docs/release/13.0/

[^pg17-uuid-extract]: PostgreSQL 17 Release Notes. *"Add functions `uuid_extract_timestamp()` and `uuid_extract_version()` to return UUID information (Andrey Borodin)."* Also: *"Allow partitioned tables to have identity columns (Ashutosh Bapat)."* https://www.postgresql.org/docs/release/17.0/

[^pg17-identity-part]: PostgreSQL 17 Release Notes. *"Allow partitioned tables to have identity columns (Ashutosh Bapat)."* https://www.postgresql.org/docs/release/17.0/

[^pg18-uuid]: PostgreSQL 18 Release Notes. *"Add UUID version 7 generation function `uuidv7()` (Andrey Borodin). This UUID value is temporally sortable. Function alias `uuidv4()` has been added to explicitly generate version 4 UUIDs."* https://www.postgresql.org/docs/release/18.0/

[^pg18-uuid-funcs]: PostgreSQL 18 — UUID Functions. *"`uuidv7([shift interval]) → uuid` — Generates a version 7 (time-ordered) UUID. The timestamp is computed using UNIX timestamp with millisecond precision + sub-millisecond timestamp + random. The optional parameter `shift` will shift the computed timestamp by the given interval."* *"`uuid_extract_timestamp(uuid) → timestamp with time zone` — Extracts a timestamp with time zone from a UUID of version 1 or 7. For other versions, this function returns null. Note that the extracted timestamp is not necessarily exactly equal to the time the UUID was generated; this depends on the implementation that generated the UUID."* *"`uuid_extract_version(uuid) → smallint` — Extracts the version from a UUID of one of the variants described by RFC 9562. For other variants, this function returns null."* https://www.postgresql.org/docs/18/functions-uuid.html

[^numeric]: PostgreSQL 16 — Numeric Types. *"The type numeric can store numbers with a very large number of digits. It is especially recommended for storing monetary amounts and other quantities where exactness is required."* *"The precision of a numeric is the total count of significant digits in the whole number, that is, the number of digits to both sides of the decimal point. The scale of a numeric is the count of decimal digits in the fractional part, to the right of the decimal point."* *"The maximum precision that can be explicitly specified in a numeric type declaration is 1000."* Table 8.2 documents the unconstrained limits: *"up to 131072 digits before the decimal point; up to 16383 digits after the decimal point."* https://www.postgresql.org/docs/16/datatype-numeric.html

[^numeric-nan]: PostgreSQL 16 — Numeric Types. *"In most implementations of the 'not-a-number' concept, NaN is not considered equal to any other numeric value (including NaN). In order to allow numeric values to be sorted and used in tree-based indexes, PostgreSQL treats NaN values as equal, and greater than all non-NaN values."* https://www.postgresql.org/docs/16/datatype-numeric.html

[^pg14-numinf]: PostgreSQL 14 Release Notes. *"Add support for Infinity and -Infinity values in the numeric data type (Tom Lane). Floating-point data types already supported these."* https://www.postgresql.org/docs/release/14.0/

[^pg15-negscale]: PostgreSQL 15 Release Notes. *"Allow the scale of a numeric value to be negative, or greater than its precision (Dean Rasheed, Tom Lane). This allows rounding of values to the left of the decimal point, e.g., `'1234'::numeric(4, -2)` returns 1200."* https://www.postgresql.org/docs/release/15.0/

[^pg18-numeric]: PostgreSQL 18 Release Notes — adds `gamma()` and `lgamma()` numeric functions; speeds up numeric multiplication and division. https://www.postgresql.org/docs/release/18.0/

[^money]: PostgreSQL 16 — Monetary Types. *"Since the output of this data type is locale-sensitive, it might not work to load money data into a database that has a different setting of lc_monetary. To avoid problems, before restoring a dump into a new database make sure lc_monetary has the same or equivalent value as in the database that was dumped."* *"Floating point numbers should not be used to handle money due to the potential for rounding errors."* Storage 8 bytes; range (assuming two fractional digits) `-92233720368547758.08 to +92233720368547758.07`. A money value can be cast to numeric without loss of precision. https://www.postgresql.org/docs/16/datatype-money.html

[^serial]: PostgreSQL 16 — Serial Types. *"CREATE TABLE tablename (colname SERIAL); is equivalent to specifying: CREATE SEQUENCE tablename_colname_seq AS integer; CREATE TABLE tablename (colname integer NOT NULL DEFAULT nextval('tablename_colname_seq')); ALTER SEQUENCE tablename_colname_seq OWNED BY tablename.colname;"* *"The type names serial and serial4 are equivalent: both create integer columns. The type names bigserial and serial8 work the same way, except that they create a bigint column. … The type names smallserial and serial2 also work the same way, except that they create a smallint column."* *"Because smallserial, serial and bigserial are implemented using sequences, there may be 'holes' or gaps in the sequence of values which appears in the column, even if no rows are ever deleted."* *"Another way is to use the SQL-standard identity column feature, described at CREATE TABLE."* https://www.postgresql.org/docs/16/datatype-numeric.html

[^identity]: PostgreSQL 16 — CREATE TABLE. *"GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [ ( sequence_options ) ] — This clause creates the column as an identity column. It will have an implicit sequence attached to it and in newly-inserted rows the column will automatically have values from the sequence assigned to it. Such a column is implicitly NOT NULL."* *"In an INSERT command, if ALWAYS is selected, a user-specified value is only accepted if the INSERT statement specifies OVERRIDING SYSTEM VALUE. If BY DEFAULT is selected, then the user-specified value takes precedence."* *"In an UPDATE command, if ALWAYS is selected, any update of the column to any value other than DEFAULT will be rejected. If BY DEFAULT is selected, the column can be updated normally. (There is no OVERRIDING clause for the UPDATE command.)"* *"The optional sequence_options clause can be used to override the parameters of the sequence. The available options include those shown for CREATE SEQUENCE, plus SEQUENCE NAME name, LOGGED, and UNLOGGED, which allow selection of the name and persistence level of the sequence."* https://www.postgresql.org/docs/16/sql-createtable.html

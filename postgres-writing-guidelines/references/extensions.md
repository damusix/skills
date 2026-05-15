# Useful Extensions


Postgres extensions are first-class — most ship with the standard distribution and just need `CREATE EXTENSION` to enable. The list below covers the extensions worth knowing for application databases; enable them when you need them, not preemptively.

## Table of Contents

- [How to Enable an Extension](#how-to-enable-an-extension)
- [pgcrypto — UUIDs, Hashing, Crypto](#pgcrypto--uuids-hashing-crypto)
- [citext — Case-Insensitive Text](#citext--case-insensitive-text)
- [pg_trgm — Fuzzy Search](#pg_trgm--fuzzy-search)
- [btree_gin / btree_gist](#btree_gin--btree_gist)
- [pg_stat_statements — Query Performance Tracking](#pg_stat_statements--query-performance-tracking)
- [pg_cron — In-DB Scheduled Jobs](#pg_cron--in-db-scheduled-jobs)
- [pgvector — Embeddings](#pgvector--embeddings)
- [PostGIS — Geospatial](#postgis--geospatial)
- [Extensions to Avoid (or Phase Out)](#extensions-to-avoid-or-phase-out)

---

## How to Enable an Extension

    CREATE EXTENSION IF NOT EXISTS pgcrypto;

`IF NOT EXISTS` makes migration scripts idempotent. Most extensions live in the `public` schema by default; you can target a different schema:

    CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA util;

For managed Postgres (RDS, Cloud SQL, Supabase, etc.), check which extensions are pre-allowed; not all are available on every host.

## pgcrypto — UUIDs, Hashing, Crypto

The single most useful extension. Provides:

- `gen_random_uuid()` — UUID v4 generator. Use this for any UUID needs; no need for `uuid-ossp`.
- `digest(data, 'sha256')` — message digests.
- `crypt(password, gen_salt('bf'))` — bcrypt password hashing.
- `encrypt(data, key, 'aes')` / `decrypt(...)` — symmetric encryption.

Common pattern:

    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE customer (
        public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
        ...
    );

    -- Password storage
    INSERT INTO app_user(email, pw_hash)
    VALUES ('alice@example.com', crypt($1, gen_salt('bf', 10)));

    -- Verification
    SELECT * FROM app_user
    WHERE email = $1 AND pw_hash = crypt($2, pw_hash);

## citext — Case-Insensitive Text

Drop-in replacement for `text` where equality and uniqueness are case-insensitive. Perfect for email columns:

    CREATE EXTENSION IF NOT EXISTS citext;

    CREATE DOMAIN email AS citext NOT NULL
        CHECK (VALUE ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$');

    CREATE TABLE customer (
        email email PRIMARY KEY,
        ...
    );

    -- These match each other:
    SELECT * FROM customer WHERE email = 'Alice@Example.com';
    SELECT * FROM customer WHERE email = 'alice@example.com';

Alternative: lowercase at write time and index `lower(email)`. citext is cleaner but slightly slower than a plain B-tree on `text`.

## pg_trgm — Fuzzy Search

Trigram-based similarity and fuzzy matching. Pairs with GIN/GiST for fast `LIKE '%abc%'` and `similarity()` queries:

    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE INDEX customer_full_name_trgm_idx
        ON customer USING GIN(full_name gin_trgm_ops);

    -- Substring match (now indexed)
    SELECT * FROM customer WHERE full_name ILIKE '%alice%';

    -- Similarity ranking
    SELECT full_name, similarity(full_name, 'alica') AS sim
    FROM customer
    WHERE full_name % 'alica'   -- % is "similar to"
    ORDER BY sim DESC LIMIT 10;

## btree_gin / btree_gist

These add scalar type support to GIN/GiST indexes — useful when you want composite indexes mixing GIN-friendly types (arrays, jsonb) with scalar types:

    CREATE EXTENSION IF NOT EXISTS btree_gin;

    -- Index combining a scalar status with an array column
    CREATE INDEX order_status_tags_idx
        ON orders USING GIN(status, tags);

Without `btree_gin`, you can't include a scalar `status` in a GIN index next to a `tags` array.

## pg_stat_statements — Query Performance Tracking

Tracks execution statistics for every query the database has run — total time, mean time, calls, rows. Indispensable for finding slow queries:

    -- Enable in postgresql.conf or via shared_preload_libraries:
    --   shared_preload_libraries = 'pg_stat_statements'
    -- Then:
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

    -- Top 10 slowest queries by total time
    SELECT query, calls, mean_exec_time, total_exec_time
    FROM pg_stat_statements
    ORDER BY total_exec_time DESC LIMIT 10;

Reset between investigations:

    SELECT pg_stat_statements_reset();

## pg_cron — In-DB Scheduled Jobs

Cron-like scheduler that runs inside Postgres. Good for queue cleanup, audit archival, materialized view refresh — anything periodic that's pure SQL:

    CREATE EXTENSION IF NOT EXISTS pg_cron;

    -- Refresh a materialized view every hour
    SELECT cron.schedule(
        'refresh-customer-ltv',
        '0 * * * *',
        $$REFRESH MATERIALIZED VIEW CONCURRENTLY mv_customer_lifetime_value$$
    );

    -- Daily audit archival
    SELECT cron.schedule(
        'archive-old-audit',
        '0 3 * * *',
        $$CALL pr_archive_customer_audit()$$
    );

Not available on every managed Postgres host; check before relying on it. Alternative: external cron + `psql` runners.

## pgvector — Embeddings

Stores and indexes vector embeddings for semantic search, RAG, recommendation engines:

    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE document_embedding (
        document_id bigint PRIMARY KEY,
        embedding   vector(1536) NOT NULL  -- e.g. OpenAI ada-002
    );

    CREATE INDEX document_embedding_idx
        ON document_embedding USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

    -- Nearest neighbors
    SELECT document_id, embedding <=> $1::vector AS distance
    FROM document_embedding
    ORDER BY embedding <=> $1::vector
    LIMIT 10;

If you're shipping AI features, pgvector means you don't need a separate vector DB for most workloads.

## PostGIS — Geospatial

Heavyweight, but the only serious answer for geospatial in Postgres. Geometry/geography types, spatial indexes, distance queries, polygon operations:

    CREATE EXTENSION IF NOT EXISTS postgis;

    CREATE TABLE location (
        location_id bigserial PRIMARY KEY,
        position    geography(POINT, 4326) NOT NULL
    );

    CREATE INDEX location_position_idx ON location USING GIST(position);

    -- Locations within 5km of a point
    SELECT * FROM location
    WHERE ST_DWithin(position, ST_MakePoint(-74.0, 40.7)::geography, 5000);

Steep learning curve, large extension. Only enable if you need it.

## Extensions to Avoid (or Phase Out)

- **`uuid-ossp`** — older UUID extension. `pgcrypto`'s `gen_random_uuid()` is simpler and ships with most distributions.
- **`hstore`** — key-value column type, predates `jsonb`. Use `jsonb` instead.
- **`pgcrypto.crypt` with `md5`/`des`** — supported for legacy but insecure. Use `bf` (bcrypt) or `xdes`.

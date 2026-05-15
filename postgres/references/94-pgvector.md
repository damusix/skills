# pgvector — Vector Similarity Search

`pgvector` extension. Adds `vector`, `halfvec`, `sparsevec` types + HNSW and IVFFlat indexes for approximate nearest-neighbor search. Six distance operators: `<->` L2, `<=>` cosine, `<#>` negative inner product, `<+>` L1 (taxicab), `<~>` hamming (bit), `<%>` jaccard (bit). Latest version **0.8.2** (2026-02-25). External extension — not in core PostgreSQL.

## Table of Contents

- [When to Use](#when-to-use)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [Vector Types](#vector-types)
    - [Distance Operators](#distance-operators)
    - [HNSW Index](#hnsw-index)
    - [IVFFlat Index](#ivfflat-index)
    - [HNSW vs IVFFlat](#hnsw-vs-ivfflat)
    - [Filtered ANN + Iterative Scans (0.8.0+)](#filtered-ann--iterative-scans-080)
    - [Index Build Tuning](#index-build-tuning)
    - [Sub-vector + Binary Quantization](#sub-vector--binary-quantization)
- [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use

Storing dense embeddings from LLM/CLIP/transformer models. Approximate nearest-neighbor search for RAG retrieval, semantic search, recommendation, deduplication by embedding similarity, image/audio similarity. ANN over millions to billions of vectors with sub-second p99.

Not for: character-level fuzzy matching (use [`93-pg-trgm.md`](./93-pg-trgm.md)), linguistic FTS (use [`20-text-search.md`](./20-text-search.md)), exact-equality lookup on opaque IDs (use B-tree + UUID/hash). pgvector indexes are *approximate* — recall < 100%. For exact-NN over small data (<10K rows), seqscan with no index is fine.

## Mental Model

Five rules:

1. **Vector types have storage limits and *separate* indexed limits.** `vector(N)`: 16,000 dimensions storage / 2,000 indexed. `halfvec(N)`: 16,000 storage / 4,000 indexed. `sparsevec(N)`: 16,000 non-zero elements storage / 1,000 nnz indexed (HNSW only). `bit(N)`: 64,000 indexed (PostgreSQL core type, used with `bit_hamming_ops` / `bit_jaccard_ops`).

2. **Six operators, six opclasses, three index types.** `<->`/`<=>`/`<#>`/`<+>` for `vector` + `halfvec` + `sparsevec`. `<~>`/`<%>` for `bit`. Each opclass binds one operator (`vector_l2_ops`, `vector_cosine_ops`, `vector_ip_ops`, `vector_l1_ops`, `halfvec_*_ops`, `sparsevec_*_ops`, `bit_hamming_ops`, `bit_jaccard_ops`). ONE opclass per index — pick the distance you query with.

3. **HNSW = better recall, slower build, more memory. IVFFlat = faster build, less memory, lower recall.** HNSW is verbatim default recommendation: *"better query performance than IVFFlat (in terms of speed-recall tradeoff), but has slower build times and uses more memory."* IVFFlat: *"faster build times and uses less memory than HNSW, but has lower query performance (in terms of speed-recall tradeoff)."*

4. **Filtered ANN was a landmine before 0.8.0.** Index returns top-K by vector distance, THEN `WHERE` filters reduce that — under-recall trap if filter is selective. Pgvector 0.8.0 added *iterative index scans* (`hnsw.iterative_scan` + `ivfflat.iterative_scan` GUCs) that re-scan until enough rows survive `WHERE`. Pre-0.8.0: must over-fetch with raised `hnsw.ef_search` or use partial indexes.

5. **Quality dials are session-scoped GUCs.** `hnsw.ef_search` (default 40) and `ivfflat.probes` (default 1) trade recall for latency at query time. Set via `SET LOCAL` per transaction or `ALTER ROLE … SET` per role. Index build params (`m`, `ef_construction`, `lists`) are baked at `CREATE INDEX` time — must `REINDEX CONCURRENTLY` to change.

> [!WARNING] pgvector is external extension
> Not bundled with PostgreSQL. Install via `CREATE EXTENSION vector` (note: extension named `vector`, not `pgvector`). Requires `pgvector` package installed on server filesystem first. Most managed providers preinstall it; self-hosted requires `apt install postgresql-XX-pgvector` or build from source. After `pg_upgrade`, verify extension binaries available on new cluster before starting.

## Decision Matrix

| Need | Use | Why |
|---|---|---|
| Default RAG embedding column 768-1536 dim | `vector(N)` + HNSW + `vector_cosine_ops` | Standard for OpenAI/Cohere/sentence-transformers embeddings. Cosine handles unnormalized vectors. |
| 4× memory reduction with marginal recall loss | `halfvec(N)` + HNSW + `halfvec_cosine_ops` | Half-precision (2-byte) floats. 16,000 storage / 4,000 indexed. Added 0.7.0. |
| Sparse term-frequency vectors (TF-IDF, BM25, SPLADE) | `sparsevec(16000)` + HNSW + `sparsevec_cosine_ops` | Stores only non-zero elements. HNSW only — IVFFlat does NOT index `sparsevec`. Added 0.7.0. |
| Compact binary embeddings (e.g., binary-quantized) | `bit(N)` + HNSW + `bit_hamming_ops` | 64,000 dimensions indexed. Use `binary_quantize(vec)` to convert. |
| Build first, query later, slower writes acceptable | HNSW | Default. Better speed-recall trade-off. |
| Faster index build, OK with lower recall | IVFFlat | Smaller index, faster build. Must specify `lists` parameter. |
| Filtered ANN with selective `WHERE` predicate | HNSW + `SET LOCAL hnsw.iterative_scan = strict_order` | 0.8.0+. Re-scans until enough rows survive `WHERE`. Pre-0.8.0: partial index per filter value. |
| Multi-tenant — partition by tenant before ANN | Partial index `WHERE tenant_id = X` per tenant OR partition table | Avoids filtered-ANN problem. |
| Tune recall vs latency per query | `SET LOCAL hnsw.ef_search = 100` | Default 40. Higher = better recall + higher latency. |
| Tune IVFFlat recall vs latency per query | `SET LOCAL ivfflat.probes = 10` | Default 1. Higher = scans more lists = better recall + slower. |
| Index storage > shared_buffers — minimize working set | IVFFlat + tune `lists` | HNSW graph must fit working memory for performance. |
| Compare distances inside expression (not just ORDER BY) | Use distance operator directly | `1 - (a <=> b)` for cosine *similarity* score. |
| Cross-encoder rerank top candidates | Use ANN to fetch top-100 → application-side rerank | pgvector returns approximate; rerank improves precision. |

Three smell signals:

- **`vector(>=2000)` with HNSW** → exceeds 2,000-dim indexed limit. Switch to `halfvec` (4,000-dim limit) OR reduce dimensionality (PCA, model truncation).
- **Filtered ANN returning < `LIMIT` rows** → ANN scan exhausted candidates before `WHERE` matched enough. Set `hnsw.iterative_scan = strict_order` (0.8.0+) OR raise `hnsw.ef_search`.
- **Building HNSW on 100M-row table without `maintenance_work_mem` raise** → swap thrashing. Raise `maintenance_work_mem` to 8-16GB AND `max_parallel_maintenance_workers` to 4-8.

## Mechanics

### Vector Types

Five callable types: `vector` (built-in float32), `halfvec` (float16, 0.7.0+), `sparsevec` (sparse, 0.7.0+), `bit` (PostgreSQL core type), and array-element types (no index support — for storage only).

| Type | Storage limit | Indexed limit (HNSW) | Indexed limit (IVFFlat) | Bytes per dim | Added |
|---|---|---|---|---|---|
| `vector(N)` | 16,000 dims | 2,000 dims | 2,000 dims | 4 (float32) | 0.1.0 |
| `halfvec(N)` | 16,000 dims | 4,000 dims | 4,000 dims | 2 (float16) | 0.7.0 |
| `sparsevec(N)` | 16,000 nnz | 1,000 nnz | (unsupported) | variable | 0.7.0 |
| `bit(N)` | 64,000 bits | 64,000 bits | (unsupported) | 0.125 | core PG |

Verbatim from [README][readme]:

> Vectors can have up to 16,000 dimensions
>
> Half vectors can have up to 16,000 dimensions
>
> Sparse vectors can have up to 16,000 non-zero elements

Construction:

    -- vector
    SELECT '[1,2,3]'::vector(3);

    -- halfvec
    SELECT '[1,2,3]'::halfvec(3);

    -- sparsevec — {index1:value1,index2:value2,...}/dimensions
    SELECT '{1:1.5,3:2.5}/5'::sparsevec;

    -- bit (binary)
    SELECT '101010'::bit(6);

    -- convert vector to bit via binary_quantize (0.7.0+)
    SELECT binary_quantize('[1,-2,3,-4]'::vector(4));
    -- 1010 (sign of each component)

`vector(N)` is the default for OpenAI text-embedding-3-small (1,536 dim), text-embedding-3-large (3,072 dim — exceeds index limit, must use `halfvec`), Cohere embed-v3 (1,024 dim), sentence-transformers all-MiniLM-L6-v2 (384 dim).

Casting between types is explicit:

    SELECT '[1,2,3]'::vector::halfvec;             -- vector → halfvec
    SELECT '[1,2,3]'::halfvec::vector;             -- halfvec → vector
    SELECT '{1:1,3:2}/5'::sparsevec::vector;       -- sparse → dense

### Distance Operators

Six operators, all return `double precision` (or `int` for bit-hamming). Lower distance = more similar.

| Operator | Distance | Range | Types | Added |
|---|---|---|---|---|
| `<->` | Euclidean (L2) | [0, ∞) | `vector`, `halfvec`, `sparsevec` | 0.1.0 |
| `<=>` | Cosine | [0, 2] | `vector`, `halfvec`, `sparsevec` | 0.1.0 |
| `<#>` | Negative inner product | (-∞, ∞) negated | `vector`, `halfvec`, `sparsevec` | 0.1.0 |
| `<+>` | L1 (taxicab/Manhattan) | [0, ∞) | `vector`, `halfvec`, `sparsevec` | 0.7.0 |
| `<~>` | Hamming | [0, N] integer | `bit` | 0.7.0 |
| `<%>` | Jaccard | [0, 1] | `bit` | 0.7.0 |

`<#>` returns *negated* inner product — so `ORDER BY a <#> b ASC` returns highest inner product (most similar). Avoids needing `DESC` for index scans (HNSW/IVFFlat scan ascending only).

Cosine *similarity* score (0-1, higher = more similar): `1 - (a <=> b)`.

Distance computation cost: L2 < IP < cosine (cosine normalizes both vectors per call). For pre-normalized vectors (unit-length), use IP — faster, equivalent ordering to cosine.

### HNSW Index

Hierarchical Navigable Small World graph. Multi-layer skip-list-like graph where higher layers are sparse. Search descends from top, navigating to nearest neighbor at each layer.

    CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops);

Default parameters:

| Parameter | Default | Range | Effect |
|---|---|---|---|
| `m` | 16 | 2-100 | Max connections per layer per vertex. Higher = better recall, more memory, slower build. |
| `ef_construction` | 64 | 4-1000 | Build-time candidate-list size. Higher = better graph quality, slower build. Must be ≥ 2×`m`. |
| `hnsw.ef_search` | 40 | 1-1000 | Query-time candidate-list size. Session GUC. Higher = better recall, slower query. |

Verbatim from [README][readme]:

> An HNSW index creates a multilayer graph. It has better query performance than IVFFlat (in terms of speed-recall tradeoff), but has slower build times and uses more memory. Also, an index can be created without any data in the table since there isn't a training step like IVFFlat.

Build with custom params:

    CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops)
    WITH (m = 32, ef_construction = 128);

Tune query recall:

    SET LOCAL hnsw.ef_search = 100;
    SELECT id FROM items ORDER BY embedding <=> $1 LIMIT 10;

`ef_search` *must* be ≥ `LIMIT`. If you want top-50, set `hnsw.ef_search >= 50`.

### IVFFlat Index

Inverted File with Flat compression. K-means partitions vectors into `lists` clusters at build time. Query scans `probes` clusters nearest to query vector.

    CREATE INDEX ON items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

Default parameters:

| Parameter | Default | Range | Effect |
|---|---|---|---|
| `lists` | (none — required) | 1-32768 | Number of clusters. **No default — you MUST specify.** |
| `ivfflat.probes` | 1 | 1-`lists` | Query-time clusters scanned. Session GUC. Higher = better recall, slower query. |
| `ivfflat.max_probes` | (= `probes`) | 1-`lists` | Iterative-scan cap (0.8.0+). |

Verbatim from [README][readme]:

> An IVFFlat index divides vectors into lists, and then searches a subset of those lists that are closest to the query vector. It has faster build times and uses less memory than HNSW, but has lower query performance (in terms of speed-recall tradeoff).

Recommended `lists` from README:

- < 1M rows: `lists = rows / 1000`
- ≥ 1M rows: `lists = sqrt(rows)`

Recommended `probes`: `sqrt(lists)` as starting point. Tune up for better recall.

IVFFlat must be built on a populated table. Building on empty table = useless (no clusters to partition). README:

> Add the data first, then create the index. Doing it the other way around will produce an index that is much less efficient.

### HNSW vs IVFFlat

| Property | HNSW | IVFFlat |
|---|---|---|
| Speed-recall trade-off | Better | Worse |
| Build time | Slower | Faster |
| Memory at build | Higher | Lower |
| Memory at query | Higher (full graph) | Lower (only probed lists) |
| Index size | Larger | Smaller |
| Insert performance | Slower (graph rebuild) | Faster (assign to nearest list) |
| Build on empty table | OK | Useless — needs populated data for k-means |
| Build parameters | `m`, `ef_construction` | `lists` |
| Query parameters | `hnsw.ef_search` | `ivfflat.probes` |
| Supports `sparsevec` | Yes | No |
| Supports `bit` | Yes | No |
| Iterative scan (0.8.0+) | `hnsw.iterative_scan` | `ivfflat.iterative_scan` |
| Parallel build (0.6.0+) | Yes | Yes |

**Pick HNSW unless** you specifically need faster builds or smaller index AND can tolerate lower recall. HNSW is the canonical recommendation for new deployments.

### Filtered ANN + Iterative Scans (0.8.0+)

The classic filtered-ANN trap:

    -- Returns up to 10 rows (often fewer) from items where category = 'shoes'
    SELECT id FROM items
    WHERE category = 'shoes'
    ORDER BY embedding <=> $1
    LIMIT 10;

Pre-0.8.0 mechanics: index returns top-`ef_search` candidates by vector distance, THEN `WHERE category = 'shoes'` filters them. If only 5 of those 40 candidates match `category`, query returns 5 rows — even though target table has 1M shoe rows.

Pgvector 0.8.0 added **iterative index scans** that re-enter the index until enough rows survive `WHERE`:

    SET LOCAL hnsw.iterative_scan = strict_order;
    SET LOCAL hnsw.max_scan_tuples = 20000;       -- default 20000
    SET LOCAL hnsw.scan_mem_multiplier = 2;       -- working memory cap

    SELECT id FROM items
    WHERE category = 'shoes'
    ORDER BY embedding <=> $1
    LIMIT 10;

Three modes for `hnsw.iterative_scan` and `ivfflat.iterative_scan`:

| Mode | Behavior |
|---|---|
| `off` (default) | Pre-0.8.0 behavior. Single index scan, may return fewer than `LIMIT` rows. |
| `strict_order` | Re-scans until `LIMIT` reached. Results sorted by exact distance. |
| `relaxed_order` | Re-scans until `LIMIT` reached. Results may be slightly out of distance order (faster). |

`hnsw.max_scan_tuples` (default 20,000) caps total tuples examined — prevents pathological full-graph scan when `WHERE` matches almost nothing. Raise for more selective filters.

`hnsw.scan_mem_multiplier` controls working-memory cap per scan. Default 1× `work_mem`. Raise to 2-4 for large `LIMIT` + iterative scans.

**Alternatives without 0.8.0+ iterative scans:**

1. **Partial indexes per filter value:**

        CREATE INDEX shoes_embedding ON items USING hnsw (embedding vector_cosine_ops)
        WHERE category = 'shoes';

    Works for low-cardinality filter columns. Index used only when planner sees matching `WHERE`.

2. **Over-fetch then filter app-side:**

        SET LOCAL hnsw.ef_search = 500;
        SELECT id FROM items
        WHERE category = 'shoes'
        ORDER BY embedding <=> $1
        LIMIT 100;

    Wasteful — most candidates discarded. Only viable for low-selectivity filters.

3. **Partition table by filter:**

        CREATE TABLE items (...) PARTITION BY LIST (category);
        CREATE INDEX ON items_shoes USING hnsw (embedding vector_cosine_ops);

    Forces planner to scan only relevant partition. See [`35-partitioning.md`](./35-partitioning.md).

### Index Build Tuning

Build time scales with row count, dimensions, `m`, `ef_construction`. For 1M-row × 1536-dim HNSW build:

    -- Raise build memory (default 64MB — woefully inadequate for HNSW)
    SET maintenance_work_mem = '8GB';

    -- Parallel build (0.6.0+) — default 2 workers
    SET max_parallel_maintenance_workers = 7;     -- 8 total with leader

    CREATE INDEX CONCURRENTLY ON items USING hnsw (embedding vector_cosine_ops);

Parallel HNSW build added pgvector 0.6.0 (2024-01-29). README recommends raising `max_parallel_maintenance_workers` for large datasets — typical reduction: 8× faster with 8 workers vs 1.

`maintenance_work_mem` rule of thumb for HNSW:

| Rows | Dims | Suggested `maintenance_work_mem` |
|---|---|---|
| 100K | 1536 | 1GB |
| 1M | 1536 | 8GB |
| 10M | 1536 | 64GB |
| 100M | 1536 | Use IVFFlat OR shard |

Insufficient `maintenance_work_mem` causes pgvector to write graph to disk during build — much slower.

Monitor build progress via `pg_stat_progress_create_index`:

    SELECT
        relid::regclass AS table,
        phase,
        round(100.0 * blocks_done / NULLIF(blocks_total, 0), 1) AS pct
    FROM pg_stat_progress_create_index;

### Sub-vector + Binary Quantization

`binary_quantize(vec)` (0.7.0+) reduces a `vector` to its sign-bit representation, returning `bit(N)`:

    SELECT binary_quantize('[1.5, -0.3, 2.7, -1.1]'::vector(4));
    -- 1010

Two-stage retrieval pattern (canonical for >100M-row + memory-constrained):

    -- Add quantized column + index
    ALTER TABLE items ADD COLUMN embedding_bin bit(1536) GENERATED ALWAYS AS (binary_quantize(embedding)::bit(1536)) STORED;
    CREATE INDEX ON items USING hnsw (embedding_bin bit_hamming_ops);

    -- Stage 1: fetch top-100 by hamming distance (fast, low memory)
    -- Stage 2: rerank top-100 by exact cosine distance
    WITH candidates AS (
        SELECT id, embedding
        FROM items
        ORDER BY embedding_bin <~> binary_quantize($1::vector)::bit(1536)
        LIMIT 100
    )
    SELECT id
    FROM candidates
    ORDER BY embedding <=> $1
    LIMIT 10;

Sub-vector indexing via expression — index portion of vector when full vector exceeds 2,000-dim limit:

    -- 3072-dim text-embedding-3-large truncated to first 1536 dims (Matryoshka)
    CREATE INDEX ON items USING hnsw ((subvector(embedding, 1, 1536)::vector(1536)) vector_cosine_ops);

    SELECT id FROM items
    ORDER BY subvector(embedding, 1, 1536)::vector(1536) <=> $1 LIMIT 10;

Query expression must EXACTLY match index expression for planner to use it.

## Per-Version Timeline

PG14-PG18 release notes contain **zero pgvector items** — pgvector is wholly external. The relevant timeline is pgvector's own release history.

| Version | Released | Key changes |
|---|---|---|
| 0.5.0 | 2023-08-28 | HNSW index type added (canonical default since this release) |
| 0.6.0 | 2024-01-29 | Parallel HNSW builds — 8× speedup with 8 workers |
| 0.7.0 | 2024-04-29 | `halfvec` (float16), `sparsevec`, `binary_quantize()`, `<+>` L1 distance, `<~>` hamming, `<%>` jaccard, `bit_hamming_ops`, `bit_jaccard_ops`, L1 indexing for HNSW |
| 0.8.0 | 2024-10-30 | Iterative index scans (`hnsw.iterative_scan`, `ivfflat.iterative_scan`), `hnsw.max_scan_tuples`, `hnsw.scan_mem_multiplier`, `ivfflat.max_probes` |
| 0.8.1 | 2025-08-12 | Bug fixes; PG18 compatibility |
| 0.8.2 | 2026-02-25 | Buffer-overflow fixes, Windows improvements (latest at planning time) |

Verify your installed version:

    SELECT extversion FROM pg_extension WHERE extname = 'vector';

> [!NOTE] PostgreSQL 14 / 15 / 16 / 17 / 18
> Zero pgvector-related items in any PG14-PG18 release notes. pgvector is provided entirely by the external extension and tracks PostgreSQL APIs across all five supported majors (verified at planning time against pgvector v0.8.2). After `pg_upgrade`, ensure `pgvector` package version supporting target PG major is installed before starting new cluster.

## Recipes

### 1. Baseline RAG embedding column with HNSW + cosine

Canonical setup for OpenAI text-embedding-3-small (1,536 dim):

    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE documents (
        id          bigserial PRIMARY KEY,
        content     text NOT NULL,
        embedding   vector(1536) NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
    );

    -- Build with raised memory (slow without)
    SET maintenance_work_mem = '4GB';
    SET max_parallel_maintenance_workers = 4;

    CREATE INDEX documents_embedding_hnsw
        ON documents USING hnsw (embedding vector_cosine_ops);

    -- Query top-10 most similar to input embedding
    SELECT id, content, 1 - (embedding <=> $1) AS similarity
    FROM documents
    ORDER BY embedding <=> $1
    LIMIT 10;

Cosine handles unnormalized vectors. If embeddings are pre-normalized (unit vectors), use IP (`<#>`) for slightly faster distance computation.

### 2. halfvec for 4× memory reduction

Same workload, half the storage + index size, marginal recall loss:

    CREATE TABLE documents_half (
        id          bigserial PRIMARY KEY,
        content     text NOT NULL,
        embedding   halfvec(1536) NOT NULL
    );

    CREATE INDEX ON documents_half USING hnsw (embedding halfvec_cosine_ops);

    -- Cast at query time if input is vector(1536)
    SELECT id FROM documents_half
    ORDER BY embedding <=> $1::halfvec(1536)
    LIMIT 10;

Use `halfvec` for budget-constrained workloads. Recall typically drops <1% vs `vector` for embedding workloads.

### 3. Filtered ANN with iterative scan (0.8.0+)

The fix for the classic filtered-ANN trap:

    -- Without iterative scan, may return fewer than 10 rows
    SET LOCAL hnsw.iterative_scan = strict_order;
    SET LOCAL hnsw.max_scan_tuples = 50000;

    SELECT id FROM documents
    WHERE category = 'engineering' AND created_at > now() - interval '90 days'
    ORDER BY embedding <=> $1
    LIMIT 10;

Returns exactly 10 rows (assuming ≥10 rows match `WHERE`). Cost: more index scans = higher latency. Tune `hnsw.max_scan_tuples` to bound worst case.

### 4. Pre-0.8.0 filtered ANN via partial indexes

When `category` has low cardinality + filter is selective:

    CREATE INDEX documents_engineering_embedding
        ON documents USING hnsw (embedding vector_cosine_ops)
        WHERE category = 'engineering';

    -- Planner uses partial index when WHERE matches predicate
    SELECT id FROM documents
    WHERE category = 'engineering'
    ORDER BY embedding <=> $1
    LIMIT 10;

One partial index per category. Maintenance cost: every UPDATE/DELETE/INSERT on `documents` re-indexes the relevant partial index.

### 5. IVFFlat baseline with `sqrt(rows)` lists

For 5M-row table, build IVFFlat with `lists = sqrt(5_000_000) ≈ 2236`:

    -- IMPORTANT: insert all data BEFORE creating IVFFlat index
    -- Building on empty table produces useless index

    CREATE INDEX documents_embedding_ivfflat
        ON documents USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 2236);

    -- Query with raised probes for better recall
    SET LOCAL ivfflat.probes = 50;       -- ~sqrt(2236)
    SELECT id FROM documents
    ORDER BY embedding <=> $1
    LIMIT 10;

Tune `ivfflat.probes` upward until recall meets target. Each doubling of `probes` roughly doubles query latency.

### 6. Per-role default `hnsw.ef_search`

Differentiate analytics-workload role from real-time API role:

    -- Real-time API: low latency, accept lower recall
    ALTER ROLE webapp SET hnsw.ef_search = 40;       -- default

    -- Analytics: higher recall, accept slower queries
    ALTER ROLE analytics SET hnsw.ef_search = 200;

    -- Verify
    SELECT rolname, rolconfig
    FROM pg_roles
    WHERE rolname IN ('webapp', 'analytics');

See [`46-roles-privileges.md`](./46-roles-privileges.md) for per-role GUC pattern. **Caveat:** pgBouncer transaction-mode pools do NOT carry per-role GUCs across connections — see [`81-pgbouncer.md`](./81-pgbouncer.md).

### 7. Hybrid search — combine vector ANN with B-tree filter

Reciprocal Rank Fusion or simple `WHERE` + ANN:

    -- Boost recent + relevant
    WITH ann AS (
        SELECT id, embedding <=> $1 AS distance
        FROM documents
        WHERE created_at > now() - interval '30 days'
        ORDER BY embedding <=> $1
        LIMIT 100
    )
    SELECT id, distance
    FROM ann
    WHERE EXISTS (
        SELECT 1 FROM document_acl
        WHERE document_id = ann.id AND user_id = $2
    )
    ORDER BY distance
    LIMIT 10;

Use `SET LOCAL hnsw.iterative_scan = strict_order` if `created_at` filter is selective.

### 8. Two-stage retrieval — binary quantize then rerank

For 100M-row deployments where full HNSW exceeds RAM:

    ALTER TABLE documents ADD COLUMN embedding_bin bit(1536)
        GENERATED ALWAYS AS (binary_quantize(embedding)::bit(1536)) STORED;

    CREATE INDEX documents_bin_hnsw
        ON documents USING hnsw (embedding_bin bit_hamming_ops);

    -- Stage 1: hamming distance fetches top-200 candidates (fast, ~150GB → ~5GB index)
    -- Stage 2: cosine distance reranks
    WITH stage1 AS (
        SELECT id, embedding
        FROM documents
        ORDER BY embedding_bin <~> binary_quantize($1::vector)::bit(1536)
        LIMIT 200
    )
    SELECT id, 1 - (embedding <=> $1) AS similarity
    FROM stage1
    ORDER BY embedding <=> $1
    LIMIT 10;

Recall typically 90-95% of full-precision HNSW at fraction of memory. Tune stage-1 `LIMIT` for recall.

### 9. Audit pgvector indexes cluster-wide

Find every vector index, opclass, and parameters:

    SELECT
        n.nspname AS schema,
        c.relname AS table,
        i.relname AS index,
        am.amname AS access_method,
        pg_size_pretty(pg_relation_size(i.oid)) AS index_size,
        opc.opcname AS opclass,
        i.reloptions AS index_options
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class c ON c.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_opclass opc ON opc.oid = ANY(ix.indclass::oid[])
    WHERE am.amname IN ('hnsw', 'ivfflat')
        AND opc.opcname LIKE '%vector%' OR opc.opcname LIKE '%halfvec%' OR opc.opcname LIKE '%sparsevec%' OR opc.opcname LIKE 'bit_%'
    ORDER BY pg_relation_size(i.oid) DESC;

`reloptions` shows build params: `{m=32,ef_construction=128}` for HNSW, `{lists=2000}` for IVFFlat.

### 10. Inspect HNSW index to verify build quality

    -- Build the pgvector pageinspect helpers (if installed) or check size
    SELECT
        relname,
        pg_size_pretty(pg_relation_size(oid)) AS size,
        reltuples::bigint AS rows,
        relpages
    FROM pg_class
    WHERE relname = 'documents_embedding_hnsw';

Rule of thumb: HNSW index size ≈ `rows × dims × 4 bytes × (1 + m / 16) × overhead`. For 1M × 1536 × `m=16`: ~7-9 GB. If significantly smaller, index may be incomplete.

### 11. REINDEX HNSW with new parameters

Index params (`m`, `ef_construction`) bake at build time. To change:

    -- Cannot ALTER INDEX to change m/ef_construction. Must REINDEX.

    SET maintenance_work_mem = '8GB';
    SET max_parallel_maintenance_workers = 7;

    -- Drop + recreate (CONCURRENTLY for online)
    CREATE INDEX CONCURRENTLY documents_embedding_hnsw_v2
        ON documents USING hnsw (embedding vector_cosine_ops)
        WITH (m = 32, ef_construction = 200);

    BEGIN;
    DROP INDEX documents_embedding_hnsw;
    ALTER INDEX documents_embedding_hnsw_v2 RENAME TO documents_embedding_hnsw;
    COMMIT;

REINDEX CONCURRENTLY also works but rebuilds with same params — useless for tuning. See [`26-index-maintenance.md`](./26-index-maintenance.md).

### 12. Test recall against ground truth

Compare ANN result to exact (seqscan) result:

    -- Disable index for ground-truth query (forces seqscan)
    SET enable_indexscan = off;
    SET enable_bitmapscan = off;
    CREATE TEMP TABLE truth AS
        SELECT id FROM documents ORDER BY embedding <=> $1 LIMIT 10;
    RESET enable_indexscan;
    RESET enable_bitmapscan;

    -- ANN query
    CREATE TEMP TABLE ann_result AS
        SELECT id FROM documents ORDER BY embedding <=> $1 LIMIT 10;

    -- Recall = |intersection| / |truth|
    SELECT count(*)::float / 10 AS recall
    FROM truth
    WHERE id IN (SELECT id FROM ann_result);

Run across diverse query vectors. Tune `hnsw.ef_search` to hit target recall (typically ≥0.95).

### 13. Bulk ingestion pattern

For 10M-row ingest, batch + index after:

    -- 1. Create table without index
    CREATE TABLE items (
        id        bigserial PRIMARY KEY,
        embedding vector(1536) NOT NULL
    );

    -- 2. Bulk-insert via COPY (fast)
    COPY items (embedding) FROM '/path/to/embeddings.csv' WITH (FORMAT csv);

    -- 3. Build index AFTER data loaded
    SET maintenance_work_mem = '16GB';
    SET max_parallel_maintenance_workers = 7;
    CREATE INDEX items_embedding_hnsw ON items USING hnsw (embedding vector_cosine_ops);

For IVFFlat, building after load is mandatory (k-means needs data). For HNSW, building after load is faster than incremental inserts during ingest.

## Operational Notes

### Storage cost estimation

Per-row storage:

| Type | Bytes per row (1536 dim) |
|---|---|
| `vector(1536)` | 1536 × 4 + 8 header = 6,152 bytes |
| `halfvec(1536)` | 1536 × 2 + 8 = 3,080 bytes |
| `sparsevec(16000)` with avg 100 nnz | ~440 bytes |
| `bit(1536)` | 192 bytes |

Heap size for 10M rows of `vector(1536)`: ~62 GB. HNSW index ~70-90 GB on top. Plan disk accordingly.

### Combining with other extensions

Common stacks:
- pgvector + `pg_stat_statements` ([`57-pg-stat-statements.md`](./57-pg-stat-statements.md)) — track ANN query latency cluster-wide.
- pgvector + `pg_trgm` ([`93-pg-trgm.md`](./93-pg-trgm.md)) — hybrid lexical + semantic search.
- pgvector + Citus ([`97-citus.md`](./97-citus.md)) — distributed ANN across shards.
- pgvector + TimescaleDB ([`96-timescaledb.md`](./96-timescaledb.md)) — time-bucketed embeddings with retention.

### When pgvector is the wrong tool

| Scenario | Better choice |
|---|---|
| Exact NN over <100K rows | Plain `vector` column, no index, seqscan |
| Character-level fuzzy match | [`93-pg-trgm.md`](./93-pg-trgm.md) |
| Linguistic FTS | [`20-text-search.md`](./20-text-search.md) |
| Billions of vectors, sub-10ms p99 | Dedicated vector DB (Milvus, Weaviate, Qdrant) — pgvector tops out ~1-10B with careful tuning |
| GPU-accelerated ANN | Dedicated vector DB |

## Gotchas

1. **`vector(2000+)` cannot be HNSW-indexed.** Hard limit: 2,000 dimensions for `vector` index. Workaround: use `halfvec(N)` (4,000-dim limit) or sub-vector via `subvector()` expression index.

2. **`sparsevec` works with HNSW only.** IVFFlat does NOT support `sparsevec`. Returns error at index creation.

3. **`bit` works with HNSW only.** Same — IVFFlat does NOT support `bit_hamming_ops` or `bit_jaccard_ops`.

4. **Filtered ANN under-recalls pre-0.8.0.** Top-`ef_search` candidates get `WHERE` filter applied, often returning fewer than `LIMIT` rows. Set `hnsw.iterative_scan = strict_order` (0.8.0+) OR use partial indexes OR over-fetch.

5. **`hnsw.ef_search < LIMIT` returns fewer rows than requested.** `ef_search` must be ≥ `LIMIT`. Default 40 means `LIMIT 100` may silently return only 40 rows.

6. **IVFFlat built on empty table is useless.** K-means needs data to partition. README: *"Add the data first, then create the index."*

7. **`lists` has no default for IVFFlat.** Must specify `WITH (lists = N)`. Recommended: `rows / 1000` for <1M, `sqrt(rows)` for ≥1M.

8. **Cosine distance on zero-magnitude vector returns NaN.** `'[0,0,0]' <=> '[1,2,3]'` → NaN (division by zero in normalization). Filter out zero vectors at insertion or during ANN.

9. **`<#>` returns NEGATED inner product.** `ORDER BY a <#> b ASC` returns highest IP first. Confusing if you expect raw IP value — multiply by -1 for actual IP.

10. **HNSW build memory must fit in `maintenance_work_mem`.** Default 64MB causes disk-spill — orders of magnitude slower. Raise to 4-16GB for typical builds.

11. **Index build params (`m`, `ef_construction`, `lists`) bake at CREATE INDEX.** Cannot change via `ALTER INDEX`. Must `DROP INDEX` + `CREATE INDEX CONCURRENTLY` with new params.

12. **`hnsw.ef_search` and `ivfflat.probes` are session GUCs.** Per-role via `ALTER ROLE … SET`. Per-query via `SET LOCAL` inside transaction. pgBouncer transaction-mode pools do NOT propagate session GUCs — see [`81-pgbouncer.md`](./81-pgbouncer.md).

13. **`CREATE INDEX CONCURRENTLY` does NOT parallelize.** PG18 added parallel CIC for B-tree but pgvector HNSW CIC remains single-threaded. For initial bulk build, prefer non-CONCURRENTLY with `max_parallel_maintenance_workers` raised.

14. **`pg_upgrade` requires pgvector binary on target cluster BEFORE starting.** New cluster must have `pgvector` extension package installed for matching PG major. Otherwise startup fails with "could not load library".

15. **Cross-architecture restore impossible.** Vector indexes are byte-level structures dependent on architecture endianness. Use `pg_dump` (logical) for cross-arch migration — see [`83-backup-pg-dump.md`](./83-backup-pg-dump.md).

16. **Cosine vs IP equivalence requires unit-normalized vectors.** Pre-normalize embeddings client-side, then use IP (`<#>`) for ~30% faster queries vs cosine.

17. **`binary_quantize()` discards magnitude.** Only sign-bit preserved. Two-stage retrieval (binary first, full reranking) recovers most of the precision loss.

18. **Iterative scans cap at `hnsw.max_scan_tuples` (default 20,000).** If filter is very selective, may still return fewer than `LIMIT` rows. Raise `max_scan_tuples` to 100K-1M for selective filters.

19. **`relaxed_order` iterative scan returns out-of-order results.** Faster than `strict_order`. If your application sorts results client-side, `relaxed_order` is fine. If you trust pgvector's ordering, use `strict_order`.

20. **Sub-vector expression index requires EXACT expression match in query.** `subvector(embedding, 1, 1536)::vector(1536)` in CREATE INDEX must appear identically in `ORDER BY` for planner to use it.

21. **HNSW index size grows roughly linearly with `m`.** Doubling `m` doubles storage + memory. Default `m=16` is good baseline.

22. **No `vector` array type indexed.** `vector[]` (array of vectors) cannot be HNSW/IVFFlat indexed. For multi-vector documents, use one row per vector (with foreign key back to document).

23. **Latest pgvector version not always compatible with latest PG.** Verify via [pgvector CHANGELOG][changelog] before upgrading PostgreSQL major. As of 2026-05-14, pgvector 0.8.2 supports PG14-PG18.

## See Also

- [`20-text-search.md`](./20-text-search.md) — linguistic FTS via `tsvector` (complement to vector for hybrid search)
- [`22-indexes-overview.md`](./22-indexes-overview.md) — index-type decision matrix
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GIN/GiST mechanics that informed pgvector index design
- [`26-index-maintenance.md`](./26-index-maintenance.md) — REINDEX CONCURRENTLY for vector indexes
- [`33-wal.md`](./33-wal.md) — vector index inserts amplify WAL volume
- [`35-partitioning.md`](./35-partitioning.md) — partition large vector tables by tenant/time
- [`46-roles-privileges.md`](./46-roles-privileges.md) — per-role `hnsw.ef_search` / `ivfflat.probes`
- [`53-server-configuration.md`](./53-server-configuration.md) — `maintenance_work_mem` for vector index builds
- [`54-memory-tuning.md`](./54-memory-tuning.md) — `shared_buffers` sizing for vector workloads
- [`56-explain.md`](./56-explain.md) — verify HNSW/IVFFlat index used (look for `Index Scan using ... hnsw`)
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — `pg_stat_user_indexes` for vector index hit rate
- [`60-parallel-query.md`](./60-parallel-query.md) — `max_parallel_maintenance_workers` for parallel HNSW build
- [`69-extensions.md`](./69-extensions.md) — `CREATE EXTENSION vector` mechanics
- [`81-pgbouncer.md`](./81-pgbouncer.md) — transaction-mode incompatibility with session GUCs
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — logical backup for cross-arch migration
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — pgvector binary must be on target cluster before starting
- [`93-pg-trgm.md`](./93-pg-trgm.md) — character-level fuzzy match (different problem class)
- [`95-postgis.md`](./95-postgis.md) — spatial similarity (complementary extension for geospatial + vector hybrid workloads)
- [`96-timescaledb.md`](./96-timescaledb.md) — vector embeddings alongside time-series data
- [`97-citus.md`](./97-citus.md) — distributed ANN across Citus shards
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-version context; pgvector evolves on its own cadence outside PG14-18 release notes
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — Recipe 1 Index Decision Flowchart row for vector similarity search

## Sources

[^1]: pgvector README. <https://github.com/pgvector/pgvector> — verbatim quotes for vector storage limits, halfvec storage, sparsevec storage, HNSW vs IVFFlat trade-off paragraph, IVFFlat *"Add the data first, then create the index"* warning. WebFetch-verified at planning time.

[^2]: pgvector CHANGELOG.md. <https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md> — per-version feature attributions: 0.5.0 HNSW (2023-08-28), 0.6.0 parallel HNSW build (2024-01-29), 0.7.0 halfvec + sparsevec + binary_quantize + L1 + hamming + jaccard (2024-04-29), 0.8.0 iterative scans (2024-10-30), 0.8.2 latest at planning time (2026-02-25). WebFetch-verified.

[^3]: pgvector GitHub releases (via gh API tags). Latest version 0.8.2 confirmed 2026-02-25 commit cab9da7. WebFetch-verified.

[^4]: PostgreSQL 14 release notes. <https://www.postgresql.org/docs/14/release-14.html> — verified ZERO pgvector-related items. WebFetch-verified.

[^5]: PostgreSQL 15 release notes. <https://www.postgresql.org/docs/15/release-15.html> — verified ZERO pgvector-related items. WebFetch-verified.

[^6]: PostgreSQL 16 release notes. <https://www.postgresql.org/docs/16/release-16.html> — verified ZERO pgvector-related items. WebFetch-verified.

[^7]: PostgreSQL 17 release notes. <https://www.postgresql.org/docs/17/release-17.html> — verified ZERO pgvector-related items. WebFetch-verified.

[^8]: PostgreSQL 18 release notes. <https://www.postgresql.org/docs/18/release-18.html> — verified ZERO pgvector-related items. WebFetch-verified.

[readme]: https://github.com/pgvector/pgvector
[changelog]: https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md
[pgtrgm-16]: https://www.postgresql.org/docs/16/pgtrgm.html

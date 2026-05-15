# BRIN, Hash, SP-GiST, and Bloom Indexes

The four non-B-tree, non-GIN/GiST access methods. Each solves a problem the bigger access methods solve badly: BRIN for *correlated append-only* data where a tiny index summarizes huge ranges; hash for *very-wide equality-only* lookups where the 4-byte hash code beats the full value; SP-GiST for *space-partitioning non-balanced* structures (k-d trees, quadtrees, radix tries); Bloom for *arbitrary-combination multi-column equality* where one index replaces many.

For the picker file with all seven access methods compared side-by-side, see [`22-indexes-overview.md`](./22-indexes-overview.md). For B-tree internals see [`23-btree-indexes.md`](./23-btree-indexes.md). For GIN/GiST see [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [BRIN Deep Dive](#brin-deep-dive)
- [Hash Deep Dive](#hash-deep-dive)
- [SP-GiST Deep Dive](#sp-gist-deep-dive)
- [Bloom Deep Dive](#bloom-deep-dive)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Load this file when:

- You have a very large append-only table (events, logs, time-series) and the leading-column data is physically correlated with insert order → BRIN.
- You have a very wide equality-only key (long URLs, hashes, base64 blobs) and want an index much smaller than a B-tree → hash.
- You have geometric points / inet / range data that needs nearest-neighbor or non-balanced partitioning → SP-GiST.
- You have a wide table where queries test arbitrary combinations of low-cardinality columns and you don't want N separate B-trees → Bloom.
- You're investigating "why is this index so much bigger than I expected" or "why does autovacuum take forever on this BRIN index."

Do **not** load this file for: scalar equality + range + sort on common types (use B-tree, see [`23-btree-indexes.md`](./23-btree-indexes.md)); array / jsonb / FTS containment (use GIN, see [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md)); range overlap / KNN on geometric types (use GiST, see [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md)).

## Mental Model

Five rules that should drive every decision in this file.

1. **BRIN summarizes block ranges, it does not list values.** Each BRIN index entry covers `pages_per_range` heap pages (default 128 = 1 MB of heap per index entry). The index is *tiny* — often 0.01% of heap size — and the query path is "consult summary, then bitmap-scan the candidate ranges from heap." Cost is index-creation O(table), index-write near-zero, query bounded by the summary's selectivity. BRIN is **useless on uncorrelated data** — see gotcha #1.

2. **Hash is a niche choice, but a real one.** Hash indexes have been WAL-logged and crash-safe since PG10[^pg10-hash]; the old "do not use hash indexes" folklore is obsolete. They store *only the 4-byte hash code*[^hash-32bit], which makes them dramatically smaller than B-tree for very long keys (UUIDs as text, URLs, S3 keys, hashes). They support only `=`[^hash-equality] and are single-column only[^hash-singlecol]. Pick B-tree by default; pick hash deliberately when the index size win dominates.

3. **SP-GiST is for non-balanced trees.** *"SP-GiST is an abbreviation for space-partitioned GiST"*[^spgist-name]. The framework supports *"a wide range of different non-balanced data structures, such as quad-trees, k-d trees, and radix trees (tries)"*[^spgist-partition]. Operationally: it does what GiST does (KNN distance ordering, geometric containment, inet, range), but with different page-layout trade-offs. The built-in `kd_point_ops` and `quad_point_ops` are the most-used opclasses.

4. **Bloom is a probabilistic index, lossy by construction.** *"A signature is a lossy representation of the indexed attribute(s), and as such is prone to reporting false positives"*[^bloom-signature]. The planner must always recheck against the heap. Bloom shines *only* when the workload tests arbitrary combinations of many columns — *"A traditional btree index is faster than a bloom index, but it can require many btree indexes to support all possible queries where one needs only a single bloom index"*[^bloom-when]. Equality-only.

5. **None of these four is the default for any common scalar.** B-tree covers the everyday workload. Reach for the four access methods in this file only after identifying a specific shape B-tree handles badly.

## Decision Matrix

Twelve rows mapping a workload shape to the recommended access method. Rows are ordered: most common first.

| Workload shape                                                  | Pick           | Avoid                  | Why                                                                                                            |
| --------------------------------------------------------------- | -------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| Append-only events ordered by `created_at` over years           | **BRIN minmax** | B-tree                 | BRIN is ~0.001% of heap size; B-tree is ~10–20% of heap. Both work; BRIN avoids the index-bloat cost.          |
| Sensor data with mostly-monotone timestamp but occasional reorder | **BRIN minmax_multi** (PG14+)[^pg14-minmax-multi] | Plain minmax | One min/max per range loses precision when ranges have outliers; multi keeps ~32 values per range.             |
| Geographic locations where range correlates loosely             | **BRIN bloom** (PG14+)[^pg14-bloom] | Plain minmax  | Bloom-filter BRIN works for data *"that is not well-localized in the heap"*[^pg14-bloom].                      |
| Long opaque IDs (UUID-as-text, URLs, base64 hashes) — equality only | **hash**       | B-tree                 | Hash stores 4-byte hash code, not the full value; index size win can be 10×+ for long keys.                    |
| Short keys with equality only (`bigint`, `uuid` binary, `int`)  | **B-tree**     | hash                   | B-tree's leaf entries are nearly as small; gains every range/sort/uniqueness predicate for free.               |
| KNN nearest-neighbor on `point`                                 | **SP-GiST `kd_point_ops`** or **GiST**         | B-tree, GIN            | Two valid choices: SP-GiST k-d tree or GiST. Benchmark for your distribution.                                  |
| IP range / network prefix lookups (inet)                        | **SP-GiST `inet_ops`** or **GiST `inet_ops`**  | B-tree                 | SP-GiST and GiST both index `<<` / `>>` containment; pick whichever benchmarks better.                         |
| Range type overlap on a non-equality column                     | **GiST**       | SP-GiST `range_ops`    | GiST is the canonical pick. SP-GiST works for narrow append-only patterns.                                     |
| Text starts-with under C locale (PG15+)                         | **B-tree `text_pattern_ops`** or SP-GiST `text_ops` | n/a               | PG15+ allows B-tree `^@` under C locale, the more common pick. SP-GiST trie remains an option for non-C cases.[^pg15-startswith] |
| Wide table, many low-cardinality columns, ad-hoc combinations   | **Bloom**      | N single-column B-trees | Bloom *"useful when a table has many attributes and queries test arbitrary combinations of them"*[^bloom-when]. |
| Append-only `inet` column with correlation                      | **BRIN `inet_inclusion_ops`** | B-tree            | The default `inet_minmax_ops` works on prefix correlation; BRIN inclusion handles subnets.                     |
| Wide-LIKE / substring on text                                   | n/a here       | hash / BRIN / SP-GiST  | This is a GIN+`pg_trgm` workload — see [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) and [`93-pg-trgm.md`](./93-pg-trgm.md). |

Three smell signals for wrong access method:

- **BRIN on uncorrelated data.** If `pg_stats.correlation` for the column is near zero, BRIN gives a tiny index that selects ~the whole table — you've gained nothing. The fix is usually `CLUSTER` (one-shot reorder) plus rethinking the schema, or pick a different index type.
- **Hash for "I want a faster index than B-tree."** Hash is almost never *faster*. Its only structural advantage is *size* on long keys. If your keys are short, B-tree wins.
- **Bloom as a default multi-column index.** Bloom is the *last resort* when the query pattern is genuinely arbitrary-combination. If you know which two or three columns dominate the predicates, build a multicolumn B-tree leading with the most selective columns.

## BRIN Deep Dive

### What BRIN Is

> *"BRIN stands for Block Range Index. BRIN is designed for handling very large tables in which certain columns have some natural correlation with their physical location within the table."*[^brin-intro]

> *"BRIN works in terms of _block ranges_ (or 'page ranges'). A block range is a group of pages that are physically adjacent in the table; for each block range, some summary info is stored by the index."*[^brin-intro]

The summary depends on the opclass. For `minmax`, it's `(min, max)`. For `minmax_multi`, it's up to 32 representative `(min, max)` pairs. For `bloom`, it's a Bloom filter over the values in the range. For `inclusion`, it's a bounding box / supernet that contains all values.

### Query Mechanics

> *"BRIN indexes can satisfy queries via regular bitmap index scans, and will return all tuples in all pages within each range if the summary info stored by the index is _consistent_ with the query conditions. The query executor is in charge of rechecking these tuples and discarding those that do not match the query conditions — in other words, these indexes are lossy."*[^brin-intro]

The planner always uses BRIN inside a **Bitmap Index Scan** node. EXPLAIN reports `Recheck Cond:` because the heap entries are filtered again after the bitmap is built.

### pages_per_range

> *"The size of the block range is determined at index creation time by the `pages_per_range` storage parameter. The number of index entries will be equal to the size of the relation in pages divided by the selected value for `pages_per_range`. Therefore, the smaller the number, the larger the index becomes (because of the need to store more index entries), but at the same time the summary data stored can be more precise and more data blocks can be skipped during an index scan."*[^brin-intro]

> *"`pages_per_range` (`integer`) — Defines the number of table blocks that make up one block range for each entry of a BRIN index. The default is `128`."*[^createindex-pageranges]

Default `pages_per_range = 128` means each index entry covers 128 × 8 KB = 1 MB of heap. For a 100 GB table that's ~100,000 index entries — typically a few hundred KB of index. Halve `pages_per_range` to 64 and the index doubles, but each candidate range is half the size.

### Summarization and autosummarize

> *"At the time of creation, all existing heap pages are scanned and a summary index tuple is created for each range, including the possibly-incomplete range at the end."*[^brin-intro]

> *"When a new page is created that does not fall within the last summarized range, the range that the new page belongs to does not automatically acquire a summary tuple; those tuples remain unsummarized until a summarization run is invoked later, creating the initial summary for that range."*[^brin-intro]

> *"if the index's `autosummarize` parameter is enabled, which it isn't by default, whenever autovacuum runs in that database, summarization will occur for all unsummarized page ranges that have been filled, regardless of whether the table itself is processed by autovacuum."*[^brin-intro]

> *"`autosummarize` (`boolean`) — Defines whether a summarization run is queued for the previous page range whenever an insertion is detected on the next one. The default is `off`."*[^createindex-pageranges]

**The `autosummarize = off` default is the single biggest BRIN footgun on append-only workloads.** Without it, fresh inserts never get summarized until you (or autovacuum on the table) explicitly call `brin_summarize_new_values`. Queries for "the last hour" will fall back to scanning the unsummarized portion of the heap — meaning the most-queried data is the data BRIN is currently useless for.

The maintenance functions[^brin-functions]:

| Function | Signature | What it does |
| --- | --- | --- |
| `brin_summarize_new_values` | `(index regclass) → integer` | *"Scans the specified BRIN index to find page ranges in the base table that are not currently summarized by the index; for any such range it creates a new summary index tuple by scanning those table pages. Returns the number of new page range summaries that were inserted into the index."* |
| `brin_summarize_range` | `(index regclass, blockNumber bigint) → integer` | *"Summarizes the page range covering the given block, if not already summarized."* |
| `brin_desummarize_range` | `(index regclass, blockNumber bigint) → void` | *"Removes the BRIN index tuple that summarizes the page range covering the given table block, if there is one."* |

### Built-in BRIN Operator Classes

Four families. The relevant ones[^brin-opclasses]:

> *"The `minmax` operator classes store the minimum and the maximum values appearing in the indexed column within the range. The `inclusion` operator classes store a value which includes the values in the indexed column within the range. The `bloom` operator classes build a Bloom filter for all values in the range. The `minmax-multi` operator classes store multiple minimum and maximum values, representing values appearing in the indexed column within the range."*[^brin-opclasses]

| Family | When | Built-in scalar/inet types |
| --- | --- | --- |
| **`*_minmax_ops`** (default) | Append-mostly with strong physical correlation. One `(min, max)` per range. | `int2`/`4`/`8`, `float4`/`8`, `numeric`, `text`, `bpchar`, `bytea`, `date`, `time`/`timetz`, `timestamp`/`timestamptz`, `interval`, `inet`, `macaddr`/`macaddr8`, `oid`, `pg_lsn`, `tid`, `uuid`, `bit`, `varbit`, `char`, `name` |
| **`*_minmax_multi_ops`** (PG14+)[^pg14-minmax-multi] | Mostly-monotone with occasional reorder/outliers. Up to 32 representative `(min, max)` pairs per range; tune with `values_per_range` (default 32, 8–256). | All numeric / temporal / network / pg_lsn / tid / uuid scalar types (see Sources for full list). |
| **`*_bloom_ops`** (PG14+)[^pg14-bloom] | Equality lookup on data that isn't physically correlated. Each range stores a small Bloom filter. Tune with `n_distinct_per_range` (default `-0.1`) and `false_positive_rate` (default `0.01`, range 0.0001 to 0.25). | All the same scalar / temporal / network types as minmax, plus inet, but NOT `text` minmax: text supports bloom and minmax. |
| **`*_inclusion_ops`** | Range/box/inet types where a single "bounding" value contains all per-range values. | `box`, `inet`, `anyrange`. |

> [!NOTE] PostgreSQL 14
> *"Allow BRIN indexes to record multiple min/max values per range (Tomas Vondra) … This is useful if there are groups of values in each page range."*[^pg14-minmax-multi]

> [!NOTE] PostgreSQL 14
> *"Allow BRIN indexes to use bloom filters (Tomas Vondra) … This allows BRIN indexes to be used effectively with data that is not well-localized in the heap."*[^pg14-bloom]

> [!NOTE] PostgreSQL 16
> *"Allow HOT updates if only BRIN-indexed columns are updated."*[^pg16-brin-hot] — This makes BRIN dramatically cheaper on hot rows: previously any update to an indexed column broke HOT; now BRIN-only-column updates remain HOT, preserving the heap-only-tuple fast path. Cross-reference [`30-hot-updates.md`](./30-hot-updates.md).

> [!NOTE] PostgreSQL 17
> *"Allow BRIN indexes to be created using parallel workers (Tomas Vondra, Matthias van de Meent)."*[^pg17-brin-parallel] — Controlled by `max_parallel_maintenance_workers`. CREATE INDEX CONCURRENTLY still does not parallelize.

### BRIN Tuning Knobs

| Knob | Default | Operational effect |
| --- | --- | --- |
| `pages_per_range` (per-index) | 128 (= 1 MB heap per entry) | Smaller → larger index, finer skipping; larger → smaller index, coarser skipping. Tune to query selectivity. |
| `autosummarize` (per-index) | `off` | When `on`, autovacuum eagerly summarizes filled ranges. **Almost always wants to be `on` for append-only tables.** |
| `values_per_range` (minmax_multi opclass parameter) | 32 (range 8–256) | More values per range → larger per-entry summary, better outlier handling. |
| `n_distinct_per_range` (bloom opclass parameter) | -0.1 (i.e. 10% of `pages_per_range × reltuples-per-page`) | Estimated distinct values per range; sizes the Bloom filter. |
| `false_positive_rate` (bloom opclass parameter) | 0.01 (range 0.0001 to 0.25) | Bloom filter false-positive target. Lower → bigger filter. |

## Hash Deep Dive

### Mechanics

Hash indexes store *only the hash code*, not the column value[^hash-32bit]:

> *"Each hash index tuple stores just the 4-byte hash value, not the actual column value. As a result, hash indexes may be much smaller than B-trees when indexing longer data items such as UUIDs, URLs, etc."*[^hash-32bit]

> *"The equivalent of a leaf page in a hash index is referred to as a bucket page. … a hash index allows accessing the bucket pages directly, thereby potentially reducing index access time in larger tables."*[^hash-bucket]

When a bucket fills, additional **overflow pages** chain to it[^hash-overflow]:

> *"When inserts mean that the bucket page becomes full, additional overflow pages are chained to that specific bucket page, locally expanding the storage for index tuples that match that hash value. When scanning a hash bucket during queries, we need to scan through all of the overflow pages."*[^hash-overflow]

Because the column value isn't in the index, every hash lookup is *lossy*[^hash-lossy]:

> *"The absence of the column value also makes all hash index scans lossy."*[^hash-lossy]

So EXPLAIN reports `Bitmap Index Scan` + `Recheck Cond:` for hash, same shape as BRIN.

### Restrictions

> *"Hash indexes support only the `=` operator, so WHERE clauses that specify range operations will not be able to take advantage of hash indexes."*[^hash-equality]

> *"Hash indexes support only single-column indexes and do not allow uniqueness checking."*[^hash-singlecol]

**Three hard restrictions, no exceptions:**

1. **Equality only** — no `<`, `>`, `BETWEEN`, no `IS NULL` index scan, no sort.
2. **Single-column only** — can't make a multicolumn hash index.
3. **Cannot be unique** — `CREATE UNIQUE INDEX … USING hash` fails. **PG18 partial relaxation**: PG18 allows non-B-tree unique indexes to be used as partition keys *if the access method supports equality*[^pg18-unique-nonbtree], but hash itself still does not support uniqueness enforcement.

### PG10 Made Hash Indexes Usable

> [!WARNING] PostgreSQL ≤ 9.6
> Hash indexes were **not WAL-logged**, **not crash-safe**, **not replicated**. The official docs themselves warned against using them. This is no longer true.

> [!NOTE] PostgreSQL 10
> *"Add write-ahead logging support to hash indexes (Amit Kapila). This makes hash indexes crash-safe and replicatable. The former warning message about their use is removed."*[^pg10-hash]
>
> Also *"Hash indexes must be rebuilt after pg_upgrade-ing from any previous major PostgreSQL version (Mithun Cy, Robert Haas, Amit Kapila). Major hash index improvements necessitated this requirement. pg_upgrade will create a script to assist with this."*[^pg10-hash-rebuild]

If you maintain a cluster that was originally on PG9.6 or earlier and upgraded forward via `pg_upgrade`, **verify that the post-upgrade hash-index rebuild script was run.** Otherwise a hash index may still be in pre-WAL-logged format.

### Maintenance

Hash indexes do **simple index tuple deletion** during VACUUM[^hash-vacuum]:

> *"Like B-Trees, hash indexes perform simple index tuple deletion. This is a deferred maintenance operation that deletes index tuples that are known to be safe to delete (those whose item identifier's LP_DEAD bit is already set)."*[^hash-vacuum]

> *"VACUUM will also try to squeeze the index tuples onto as few overflow pages as possible, minimizing the overflow chain. If an overflow page becomes empty, overflow pages can be recycled for reuse in other buckets, though we never return them to the operating system."*[^hash-vacuum]

> [!NOTE] PostgreSQL 17
> *"Allow the creation of hash indexes on ltree columns (Tommy Pavlicek). This also enables hash join and hash aggregation on ltree columns."*[^pg17-hash-ltree]

## SP-GiST Deep Dive

### What SP Stands For

> *"SP-GiST is an abbreviation for space-partitioned GiST."*[^spgist-name]

> *"SP-GiST supports partitioned search trees, which facilitate development of a wide range of different non-balanced data structures, such as quad-trees, k-d trees, and radix trees (tries). The common feature of these structures is that they repeatedly divide the search space into partitions that need not be of equal size."*[^spgist-partition]

The contrast with GiST: GiST is a *balanced* tree-of-bounding-predicates; SP-GiST is *deliberately unbalanced* with space-partitioning. For some workloads (k-d trees on uniformly distributed points, radix-tries on prefix-clustered text) SP-GiST gives shorter average lookup depth than GiST.

### Built-in SP-GiST Operator Classes

Seven built-in opclasses[^spgist-opclasses]:

| Opclass | Type | Indexable operators | Ordering operators (KNN) | Notes |
| --- | --- | --- | --- | --- |
| `box_ops` | `box` | `<<`, `&<`, `&>`, `>>`, `<@`, `@>`, `~=`, `&&`, `<<\|`, `&<\|`, `\|&>`, `\|>>` | `<->` (box, point) | Default for `box`. |
| `inet_ops` | `inet` | `<<`, `<<=`, `>>`, `>>=`, `=`, `<>`, `<`, `<=`, `>`, `>=`, `&&` | (none) | Default for `inet` / `cidr` in SP-GiST. |
| `kd_point_ops` | `point` | `\|>>`, `<<`, `>>`, `<<\|`, `~=`, `<@` (point, box) | `<->` (point, point) | k-d tree. Alternative to `quad_point_ops`. |
| `poly_ops` | `polygon` | `<<`, `&<`, `&>`, `>>`, `<@`, `@>`, `~=`, `&&`, `<<\|`, `&<\|`, `\|>>`, `\|&>` | `<->` (polygon, point) | |
| `quad_point_ops` | `point` | `\|>>`, `<<`, `>>`, `<<\|`, `~=`, `<@` (point, box) | `<->` (point, point) | Quadtree. Default for `point`. |
| `range_ops` | `anyrange` | `=`, `&&`, `@>`, `<@`, `<<`, `>>`, `&<`, `&>`, `-\|-` | (none) | |
| `text_ops` | `text` | `=`, `<`, `<=`, `>`, `>=`, `~<~`, `~<=~`, `~>=~`, `~>~`, `^@` | (none) | Radix-trie. Useful for prefix lookups when B-tree `text_pattern_ops` is impractical. |

The KNN columns (`<->` with the appropriate type pair) are *only* fast when the query has a small `LIMIT`. See gotcha #11.

### Version Notes

> [!NOTE] PostgreSQL 14
> *"Allow SP-GiST indexes to contain INCLUDE'd columns (Pavel Borisov)."*[^pg14-spgist-include] — Aligns SP-GiST with B-tree's PG11 covering-index feature. Useful for index-only scans on SP-GiST-indexable types.

> [!NOTE] PostgreSQL 17
> *"Allow GiST and SP-GiST indexes to be part of incremental sorts (Miroslav Bendik) … This is particularly useful for ORDER BY clauses where the first column has a GiST and SP-GiST index, and other columns do not."*[^pg17-spgist-incsort] — Cross-reference [`59-planner-tuning.md`](./59-planner-tuning.md) for `enable_incremental_sort`.

### Picking SP-GiST vs GiST

For the same problem (KNN, range overlap, inet, text prefix) both GiST and SP-GiST may have built-in opclasses. **Benchmark both** on representative data; there is no universal winner.

Heuristics:

- **Uniform point distributions** — k-d tree (SP-GiST `kd_point_ops`) often wins.
- **Highly skewed point distributions** — GiST often wins, because GiST's R-tree-like bounding boxes handle clusters well.
- **Text prefix lookups under non-C locale** — SP-GiST `text_ops` (radix trie) avoids the "B-tree under locale rules" complexity that forces `text_pattern_ops`. See [`23-btree-indexes.md`](./23-btree-indexes.md).
- **Range overlap with EXCLUDE constraints** — GiST is the only option; SP-GiST cannot back exclusion constraints with the same generality.

## Bloom Deep Dive

### What Bloom Is

> *"`bloom` provides an index access method based on Bloom filters."*[^bloom-intro]

> *"A Bloom filter is a space-efficient data structure that is used to test whether an element is a member of a set. In the case of an index access method, it allows fast exclusion of non-matching tuples via signatures whose size is determined at index creation."*[^bloom-intro]

The Bloom extension is *contrib* — installed via `CREATE EXTENSION bloom;`. It's not loaded by default. Most managed providers include it in their allowlist; for self-hosted bare-metal it's part of the `postgresql-contrib` package.

### Signature Mechanics

> *"A signature is a lossy representation of the indexed attribute(s), and as such is prone to reporting false positives; that is, it may be reported that an element is in the set, when it is not. So index search results must always be rechecked using the actual attribute values from the heap entry. Larger signatures reduce the odds of a false positive and thus reduce the number of useless heap visits, but of course also make the index larger and hence slower to scan."*[^bloom-signature]

EXPLAIN reports Bloom scans as `Bitmap Index Scan` + `Recheck Cond:` — same shape as BRIN and hash.

### Parameters

Two parameter families[^bloom-params]:

> *"`length` — Length of each signature (index entry) in bits. It is rounded up to the nearest multiple of 16. The default is 80 bits and the maximum is 4096."*[^bloom-params]

> *"`col1 — col32` — Number of bits generated for each index column. Each parameter's name refers to the number of the index column that it controls. The default is 2 bits and the maximum is 4095. Parameters for index columns not actually used are ignored."*[^bloom-params]

Default `length = 80`, default `col1` through `colN = 2` bits each. For a five-column Bloom that's 10 bits of "signal" per index entry in an 80-bit space — leaving 70 bits to deal with hash collisions across multiple columns simultaneously.

### When Bloom Wins

> *"This type of index is most useful when a table has many attributes and queries test arbitrary combinations of them. A traditional btree index is faster than a bloom index, but it can require many btree indexes to support all possible queries where one needs only a single bloom index. Note however that bloom indexes only support equality queries, whereas btree indexes can also perform inequality and range searches."*[^bloom-when]

The canonical Bloom use case: a row in a wide dimension table where any query may filter on any combination of 5–10 low-cardinality columns. One Bloom index serves every combination; the alternative is up to 2ⁿ B-trees.

### Hard Limitations

- **Equality only.** No ranges, no `IS NULL`-as-index-scan, no sort.
- **Lossy, always.** Every match requires a heap recheck.
- **Single-column index makes no sense** — for a single column, B-tree (smaller per entry) or hash (smaller per entry) wins.
- **Limited cardinality per column.** Two-bit per-column signatures collide quickly when the column has many distinct values. Bloom is for *low-cardinality* columns combined.

## Per-Version Timeline

Cumulative changes affecting the four access methods in this file.

| Version | Change | Source quote |
| --- | --- | --- |
| **PG10** | Hash indexes WAL-logged & crash-safe | *"This makes hash indexes crash-safe and replicatable. The former warning message about their use is removed."*[^pg10-hash] |
| **PG10** | Hash indexes must be rebuilt post-`pg_upgrade` from ≤9.6 | Quoted in full above[^pg10-hash-rebuild] |
| **PG14** | BRIN `minmax_multi` opclass family | *"Allow BRIN indexes to record multiple min/max values per range … useful if there are groups of values in each page range."*[^pg14-minmax-multi] |
| **PG14** | BRIN `bloom` opclass family | *"Allow BRIN indexes to use bloom filters … effectively with data that is not well-localized in the heap."*[^pg14-bloom] |
| **PG14** | SP-GiST gains INCLUDE columns | *"Allow SP-GiST indexes to contain INCLUDE'd columns."*[^pg14-spgist-include] |
| **PG15** | B-tree `^@` starts-with under C locale alternative to SP-GiST | *"Previously these could only use SP-GiST indexes."*[^pg15-startswith] |
| **PG16** | HOT updates allowed when only BRIN-indexed columns change | *"Allow HOT updates if only BRIN-indexed columns are updated."*[^pg16-brin-hot] |
| **PG17** | Parallel BRIN index build | *"Allow BRIN indexes to be created using parallel workers."*[^pg17-brin-parallel] |
| **PG17** | GiST and SP-GiST in incremental sorts | *"Allow GiST and SP-GiST indexes to be part of incremental sorts."*[^pg17-spgist-incsort] |
| **PG17** | Hash indexes on `ltree` | *"Allow the creation of hash indexes on ltree columns … This also enables hash join and hash aggregation on ltree columns."*[^pg17-hash-ltree] |
| **PG18** | Non-B-tree unique indexes as partition keys (must support equality) | *"The index type must still support equality."*[^pg18-unique-nonbtree] — Hash supports equality but does not enforce uniqueness, so this primarily applies to other access methods. |

## Examples / Recipes

### Recipe 1 — BRIN minmax baseline for an append-only events table

The most common BRIN use case. An events table partitioned by month with `created_at` monotone within each partition. One BRIN index per partition is dramatically smaller than the equivalent B-tree.

    CREATE TABLE events (
        event_id    bigint GENERATED ALWAYS AS IDENTITY,
        created_at  timestamptz NOT NULL,
        user_id     bigint NOT NULL,
        payload     jsonb
    ) PARTITION BY RANGE (created_at);

    CREATE TABLE events_2026_05 PARTITION OF events
        FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

    -- BRIN with autosummarize ON because this is append-only.
    CREATE INDEX events_2026_05_created_at_brin
        ON events_2026_05 USING brin (created_at)
        WITH (pages_per_range = 128, autosummarize = on);

For a 50 GB partition with `pages_per_range = 128`, expect BRIN ~3–5 MB. Equivalent B-tree would be ~6–12 GB.

Query plan check — confirm BRIN is being used and the range-summary skip is happening:

    EXPLAIN (ANALYZE, BUFFERS)
    SELECT event_id, user_id, payload
    FROM events_2026_05
    WHERE created_at >= '2026-05-22 14:00' AND created_at < '2026-05-22 15:00';

Look for `Bitmap Index Scan on events_2026_05_created_at_brin` + `Bitmap Heap Scan` + `Recheck Cond:` + a `Buffers: shared hit=…` count well below the full table size.

### Recipe 2 — Verify correlation before reaching for BRIN

BRIN is useless on uncorrelated data. Check `pg_stats.correlation` first:

    ANALYZE events_2026_05;

    SELECT attname, correlation
    FROM pg_stats
    WHERE schemaname = 'public'
      AND tablename  = 'events_2026_05'
      AND attname IN ('created_at', 'user_id');

Correlation is in `[-1, 1]`. Rules of thumb:

- `|correlation| > 0.9` → BRIN is excellent.
- `0.5 < |correlation| < 0.9` → BRIN works but loses precision; consider `minmax_multi`.
- `|correlation| < 0.5` → BRIN is a poor choice; use B-tree or `CLUSTER` the table first.

### Recipe 3 — BRIN minmax_multi for mostly-monotone with outliers (PG14+)

Sensor data ingested mostly in order, but with occasional out-of-order arrivals (network retries, clock skew). Plain `minmax` collapses the entire range to `(global_min, global_max)`, defeating BRIN.

    CREATE INDEX sensor_readings_ts_brin
        ON sensor_readings
        USING brin (recorded_at timestamptz_minmax_multi_ops)
        WITH (pages_per_range = 64, autosummarize = on);

    -- Tune values_per_range via opclass parameter (PG14+).
    CREATE INDEX sensor_readings_ts_brin_v2
        ON sensor_readings
        USING brin (recorded_at timestamptz_minmax_multi_ops (values_per_range = 64))
        WITH (pages_per_range = 64, autosummarize = on);

The `values_per_range = 64` doubles the per-entry storage but holds twice as many `(min, max)` pairs per range, dramatically improving selectivity when outliers exist.

### Recipe 4 — BRIN bloom for equality on uncorrelated data (PG14+)

A wide append-only audit log where you want to filter by `user_id` (equality, but not physically clustered).

    CREATE INDEX audit_log_user_id_brin
        ON audit_log
        USING brin (user_id int8_bloom_ops)
        WITH (pages_per_range = 64, autosummarize = on);

The Bloom-filter BRIN per range tells the planner "user 12345 *might* appear in ranges A, F, K" — which is cheaper than a B-tree on a 500 GB log but useful only for equality.

### Recipe 5 — Force-summarize a stale BRIN after a bulk load

Default `autosummarize = off` means a fresh bulk load leaves new pages unsummarized. Always force-summarize after big inserts:

    SELECT brin_summarize_new_values('events_2026_05_created_at_brin');

The return value is the number of new range summaries created. Wrap in a nightly job (cross-reference [`98-pg-cron.md`](./98-pg-cron.md)):

    -- Scheduled BRIN summarization for an append-only table.
    SELECT cron.schedule(
        'brin-summarize-events',
        '*/15 * * * *',
        $$SELECT brin_summarize_new_values('events_2026_05_created_at_brin')$$
    );

For PG14+ workloads, preferring `autosummarize = on` per-index is usually simpler.

### Recipe 6 — Hash index for very long opaque keys

A table where `external_request_id` is a 40-char hex hash and the only query is exact lookup. B-tree would be ~50 bytes per entry (40 char key + tuple header); hash is a flat 4-byte hash code.

    CREATE INDEX webhook_log_request_id_hash
        ON webhook_log
        USING hash (external_request_id);

    SELECT * FROM webhook_log WHERE external_request_id = 'a1b2…';

Verify plan shape:

    EXPLAIN (ANALYZE, BUFFERS)
    SELECT * FROM webhook_log WHERE external_request_id = 'a1b2c3…';

Look for `Bitmap Index Scan on webhook_log_request_id_hash` + `Recheck Cond:` (recheck is mandatory because hash is lossy). For very long keys the hash index can be 5–10× smaller than the B-tree alternative.

If you ever need range, prefix, or sort on this column, drop the hash and use B-tree — hash supports *only* `=`.

### Recipe 7 — SP-GiST k-d tree for nearest-neighbor on point

The canonical KNN pattern, picking SP-GiST `kd_point_ops` as an alternative to GiST.

    CREATE INDEX poi_location_spgist
        ON points_of_interest
        USING spgist (location kd_point_ops);

    SELECT name
    FROM points_of_interest
    ORDER BY location <-> POINT(-122.4194, 37.7749)
    LIMIT 10;

Verify in EXPLAIN that there is **no Sort node** above the Index Scan — that's the signature of true index-driven KNN. Without LIMIT the index won't accelerate ordering and the plan is no better than a sequential scan with sort.

For real-world geospatial work use **PostGIS** with GiST or SP-GiST on `geometry` / `geography` types. See [`95-postgis.md`](./95-postgis.md).

### Recipe 8 — SP-GiST radix-trie for inet containment

Multi-tenant IP-block lookups where you want to answer "which CIDR block contains this address."

    CREATE INDEX ip_blocks_spgist
        ON ip_blocks
        USING spgist (block inet_ops);

    SELECT block, tenant_id
    FROM ip_blocks
    WHERE block >>= inet '203.0.113.42';

Benchmark against GiST `inet_ops` on representative data. Either may win depending on the depth of address prefix sharing.

### Recipe 9 — Bloom for arbitrary-combination filters on a wide table

A reporting fact table with eight low-cardinality columns. Queries may filter on any 1–3 of them simultaneously. The B-tree alternative would be ~2⁸ = 256 potential indexes.

    CREATE EXTENSION IF NOT EXISTS bloom;

    CREATE INDEX fact_sales_bloom
        ON fact_sales
        USING bloom (
            region_id, channel_id, product_id,
            customer_segment, fiscal_period, currency_code,
            payment_method, fraud_flag
        )
        WITH (length = 128, col1 = 4, col2 = 4, col3 = 4,
              col4 = 2, col5 = 2, col6 = 2, col7 = 2, col8 = 1);

The `length = 128` widens the per-entry signature to 128 bits (rounded up to nearest 16). The per-column bit allocation increases signal for the highest-cardinality columns (`region_id`, `channel_id`, `product_id` at 4 bits each).

    EXPLAIN (ANALYZE, BUFFERS)
    SELECT count(*)
    FROM fact_sales
    WHERE region_id = 12
      AND product_id = 4567
      AND payment_method = 'CARD';

Look for `Bitmap Index Scan on fact_sales_bloom` + `Recheck Cond:`. Bloom is *always* a bitmap scan.

### Recipe 10 — Audit: index size vs heap size to validate BRIN's main pitch

    SELECT
        n.nspname        AS schema_name,
        c.relname        AS index_name,
        c2.relname       AS table_name,
        pg_size_pretty(pg_relation_size(c.oid))           AS index_size,
        pg_size_pretty(pg_relation_size(c2.oid))          AS heap_size,
        round(100.0 * pg_relation_size(c.oid)
                / NULLIF(pg_relation_size(c2.oid), 0), 4) AS index_pct_of_heap,
        am.amname AS index_method
    FROM pg_index i
    JOIN pg_class c   ON c.oid  = i.indexrelid
    JOIN pg_class c2  ON c2.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am am     ON am.oid = c.relam
    WHERE am.amname IN ('brin', 'hash', 'spgist', 'bloom')
    ORDER BY c.relam, pg_relation_size(c.oid) DESC;

For BRIN indexes on append-only tables, `index_pct_of_heap` should be well under 0.1%. If a BRIN index is reporting 5–10% of heap size, something is wrong (`pages_per_range` too small, or the access method is doing unexpected per-row indexing).

### Recipe 11 — Audit: BRIN summarization lag

Pages in the table that have no corresponding summary entry in the BRIN index:

    -- Run after a bulk load to confirm BRIN is current.
    SELECT relname,
           pg_relation_size(oid) / current_setting('block_size')::int AS heap_pages
    FROM pg_class
    WHERE relname = 'events_2026_05';

    -- This will return >0 if any new pages need summarization.
    SELECT brin_summarize_new_values('events_2026_05_created_at_brin');

If `brin_summarize_new_values` returns nonzero values regularly during normal query traffic, the index has unsummarized ranges and queries against recent data are falling back to heap scans. Switch to `autosummarize = on` or schedule a regular summarization job.

### Recipe 12 — PG17+ parallel BRIN build for very large indexes

    -- Allow up to 4 parallel maintenance workers for index build.
    SET max_parallel_maintenance_workers = 4;
    SET maintenance_work_mem = '2GB';

    CREATE INDEX events_created_at_brin
        ON events
        USING brin (created_at)
        WITH (pages_per_range = 128, autosummarize = on);

Watch progress live:

    SELECT pid, datname, command, phase, blocks_done, blocks_total,
           round(100.0 * blocks_done / NULLIF(blocks_total, 0), 1) AS pct
    FROM pg_stat_progress_create_index;

CREATE INDEX CONCURRENTLY does **not** parallelize, even on PG17+ — same restriction as B-tree and GIN.

### Recipe 13 — Inventory the non-default access methods in your database

    SELECT
        am.amname                              AS access_method,
        n.nspname                              AS schema,
        c2.relname                             AS table_name,
        c.relname                              AS index_name,
        pg_size_pretty(pg_relation_size(c.oid)) AS index_size,
        ix.indisunique                         AS unique,
        ix.indisvalid                          AS valid,
        pg_get_indexdef(c.oid)                 AS index_def
    FROM pg_index ix
    JOIN pg_class c     ON c.oid  = ix.indexrelid
    JOIN pg_class c2    ON c2.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid  = c.relnamespace
    JOIN pg_am am       ON am.oid = c.relam
    WHERE am.amname IN ('brin', 'hash', 'spgist', 'bloom')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY am.amname, pg_relation_size(c.oid) DESC;

Useful before a planned PG-major upgrade or as a baseline before a tuning pass.

## Gotchas / Anti-patterns

1. **BRIN on uncorrelated data is functionally a no-op.** The summary `(min, max)` per range covers the entire data range, so the planner has to read every range. Confirm `pg_stats.correlation > 0.5` (preferably `> 0.9`) on the indexed column before creating BRIN. The fix is `CLUSTER` (one-shot heap reorder, takes ACCESS EXCLUSIVE) or rethinking the table's physical layout.

2. **`autosummarize = off` is the silent BRIN footgun.** Default is `off`. Fresh appends never get summarized until you call `brin_summarize_new_values` or autovacuum runs. Set `autosummarize = on` for append-only workloads (see §Summarization and autosummarize above).

3. **`brin_summarize_new_values` is per-index, not per-database.** No "summarize all BRIN" admin function exists. If you have BRIN on 50 partitions, you need 50 calls — typically wrapped in a `DO` block iterating over `pg_class` filtered by `relam`.

4. **Hash indexes pre-PG10 were not crash-safe.** See §PG10 Made Hash Indexes Usable above. If your cluster was upgraded from ≤9.6 via `pg_upgrade`, verify the post-upgrade rebuild script was run.

5. **Hash indexes are equality-only and single-column.** See §Restrictions above. If your workload needs `<`, `>`, `BETWEEN`, sort, or multicolumn, hash is wrong regardless of size advantage.

6. **Hash indexes cannot enforce uniqueness.** *"Hash indexes support only single-column indexes and do not allow uniqueness checking."*[^hash-singlecol] Even PG18's relaxation of "non-B-tree unique on partition keys" does not change this — the index type must *support* equality (hash does) *and* uniqueness enforcement (hash does not).

7. **Every hash lookup is lossy.** *"The absence of the column value also makes all hash index scans lossy."*[^hash-lossy] Every match requires a heap recheck. For very long keys this is still a win because the index is so much smaller; for short keys the recheck eats the win.

8. **SP-GiST is not GiST.** They share a name and conceptual lineage but are operationally separate access methods with different opclasses, different page-layout characteristics, and different planner cost models. A function or opclass that exists for GiST may not exist for SP-GiST and vice versa.

9. **SP-GiST cannot back EXCLUDE constraints with the same generality as GiST.** EXCLUDE constraints commonly use `EXCLUDE USING gist (period WITH &&)`. SP-GiST supports some operators GiST does, but the EXCLUDE constraint must use a GiST-supported access method for the canonical room-reservation pattern. See [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) for the GiST EXCLUDE deep dive.

10. **SP-GiST without INCLUDE pre-PG14 cannot do index-only scans efficiently.** PG14+ added INCLUDE columns to SP-GiST[^pg14-spgist-include]; pre-PG14 the only way to get covering behavior was through the indexed expressions themselves.

11. **KNN with SP-GiST `kd_point_ops` is only fast with `LIMIT`.** Without LIMIT, the planner often picks a Sort over a sequential scan. EXPLAIN should show **no Sort node** above the Index Scan; if you see Sort, the index is not being used for ordering.

12. **Bloom is lossy by construction.** Every scan rechecks against the heap. See §Signature Mechanics above for tuning `length` and per-column bit allocation for high-cardinality columns.

13. **Bloom supports only equality.** No ranges, no `BETWEEN`, no sort, no `IS NULL` as an index condition. If even one query in your workload needs a range, Bloom is the wrong choice for that workload.

14. **Bloom for a single column is almost always wrong.** Single-column Bloom is bigger than hash (which is also lossy and equality-only) and bigger than B-tree (which supports every predicate). Bloom is for *multi-column, arbitrary-combination* queries.

15. **Bloom requires the `bloom` extension.** *"`bloom` provides an index access method based on Bloom filters."*[^bloom-intro] — it's a contrib extension. Run `CREATE EXTENSION bloom;` before `CREATE INDEX … USING bloom`. Most managed providers ship it in the allowlist; self-hosted requires the `postgresql-contrib` package.

16. **CREATE INDEX CONCURRENTLY does not parallelize for any of these access methods.** PG17 added parallel BRIN build, but only via the non-CONCURRENTLY path. For online builds on a production table, expect significantly longer index-build times. Plan maintenance windows accordingly.

17. **BRIN indexes with `pages_per_range` too small approach B-tree size.** The whole point of BRIN is "tiny index, lossy bitmap scan." If you set `pages_per_range = 4` (32 KB heap per entry) on a 1 GB table, you have ~32k index entries — comparable to a B-tree's leaf count for that table. Pick `pages_per_range` to match your typical query selectivity, not your row count.

18. **BRIN inclusion opclass on ranges may misreport empty ranges.** Empty ranges (`int4range 'empty'`) have ambiguous containment semantics. If you store empty ranges in a range column with a BRIN inclusion index, the index summary may not correctly exclude page ranges that contain only empty values. See [`15-data-types-custom.md`](./15-data-types-custom.md) gotchas for empty-vs-unbounded range behavior.

19. **SP-GiST text_ops doesn't help `LIKE '%foo%'`.** SP-GiST's radix-trie indexes anchored prefixes only (`LIKE 'foo%'`, `^@`, `=`, range comparisons). Non-anchored substring search needs `pg_trgm` GIN. See [`93-pg-trgm.md`](./93-pg-trgm.md).

20. **Hash + ICU collation + `=` does not always use the hash index.** Hash indexes on text columns rely on the type's hash function, which may not be consistent with non-default collation `=` comparison rules. If your table column has a non-default collation, queries comparing the column with a literal under a different collation may not pick the hash index. Cross-reference [`65-collations-encoding.md`](./65-collations-encoding.md).

21. **Bloom's `length` parameter rounds up to nearest 16.** Setting `length = 100` actually produces a 112-bit signature. Plan capacity calculations around the rounding.

22. **BRIN summarization holds a `ShareUpdateExclusiveLock` on the index** (not on the table). It conflicts with VACUUM FULL, CLUSTER, REINDEX, and ALTER INDEX on the same index, but does not block ordinary DML. Schedule summarization to avoid simultaneous reindexing.

## See Also

- [`22-indexes-overview.md`](./22-indexes-overview.md) — Picker file: which of seven access methods to use for which workload.
- [`23-btree-indexes.md`](./23-btree-indexes.md) — B-tree internals, deduplication, bottom-up deletion, skip scan, INCLUDE.
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GIN inverted indexes and GiST generalized trees; the canonical alternatives to SP-GiST and Bloom.
- [`26-index-maintenance.md`](./26-index-maintenance.md) — `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, bloat detection.
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — VACUUM's interaction with BRIN summarization and hash overflow page recycling.
- [`30-hot-updates.md`](./30-hot-updates.md) — PG16 HOT-on-BRIN-only-update change.
- [`35-partitioning.md`](./35-partitioning.md) — Per-partition BRIN indexes are the canonical pattern for very large time-series tables.
- [`56-explain.md`](./56-explain.md) — Reading `Bitmap Index Scan` + `Recheck Cond:` plans, which BRIN/hash/Bloom all use.
- [`59-planner-tuning.md`](./59-planner-tuning.md) — `enable_incremental_sort` (PG13+, PG17 SP-GiST/GiST), `max_parallel_maintenance_workers`.
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_am`, `pg_opclass`, `pg_opfamily` introspection.
- [`93-pg-trgm.md`](./93-pg-trgm.md) — Trigram alternatives for substring / fuzzy lookups (the workload that none of BRIN/hash/SP-GiST/Bloom handles).
- [`95-postgis.md`](./95-postgis.md) — PostGIS geometry/geography, the production answer to nearest-neighbor over real coordinates.
- [`98-pg-cron.md`](./98-pg-cron.md) — Scheduling `brin_summarize_new_values` for append-only tables without `autosummarize`.
- [`15-data-types-custom.md`](./15-data-types-custom.md) — Empty-vs-unbounded range semantics relevant to BRIN inclusion opclass on range columns.

## Sources

[^brin-intro]: PostgreSQL 16 docs, "BRIN — Introduction." Verbatim: *"BRIN stands for Block Range Index. BRIN is designed for handling very large tables in which certain columns have some natural correlation with their physical location within the table."* and the full mechanism, summarization, and autosummarize quotes. https://www.postgresql.org/docs/16/brin-intro.html
[^brin-opclasses]: PostgreSQL 16 docs, "BRIN — Built-in Operator Classes." Lists minmax, minmax_multi, inclusion, and bloom families plus full per-type opclass enumeration; verbatim summary text used in deep dive. https://www.postgresql.org/docs/16/brin-builtin-opclasses.html
[^brin-functions]: PostgreSQL 16 docs, "Index Maintenance Functions." Verbatim signatures and descriptions of `brin_summarize_new_values`, `brin_summarize_range`, `brin_desummarize_range`. https://www.postgresql.org/docs/16/functions-admin.html
[^createindex-pageranges]: PostgreSQL 16 docs, "CREATE INDEX — Index Storage Parameters." Verbatim `pages_per_range` and `autosummarize` definitions. https://www.postgresql.org/docs/16/sql-createindex.html
[^hash-32bit]: PostgreSQL 16 docs, "Hash Indexes — Overview." Verbatim: *"Each hash index tuple stores just the 4-byte hash value, not the actual column value. As a result, hash indexes may be much smaller than B-trees when indexing longer data items such as UUIDs, URLs, etc."* https://www.postgresql.org/docs/16/hash-intro.html
[^hash-bucket]: Same source. Verbatim: *"The equivalent of a leaf page in a hash index is referred to as a bucket page. In contrast, a hash index allows accessing the bucket pages directly, thereby potentially reducing index access time in larger tables."* https://www.postgresql.org/docs/16/hash-intro.html
[^hash-overflow]: Same source. Verbatim overflow-page chaining description. https://www.postgresql.org/docs/16/hash-intro.html
[^hash-lossy]: Same source. Verbatim: *"The absence of the column value also makes all hash index scans lossy."* https://www.postgresql.org/docs/16/hash-intro.html
[^hash-equality]: PostgreSQL 16 docs, "Index Types." Verbatim: *"Hash indexes store a 32-bit hash code derived from the value of the indexed column. Hence, such indexes can only handle simple equality comparisons."* and *"Hash indexes support only the `=` operator, so WHERE clauses that specify range operations will not be able to take advantage of hash indexes."* https://www.postgresql.org/docs/16/indexes-types.html
[^hash-singlecol]: PostgreSQL 16 docs, "Hash Indexes — Overview." Verbatim: *"Hash indexes support only single-column indexes and do not allow uniqueness checking."* https://www.postgresql.org/docs/16/hash-intro.html
[^hash-vacuum]: PostgreSQL 16 docs, "Hash Indexes — Implementation." Verbatim quotes on VACUUM behavior and overflow-page recycling. https://www.postgresql.org/docs/16/hash-implementation.html
[^spgist-name]: PostgreSQL 16 docs, "SP-GiST Indexes — Introduction." Verbatim: *"SP-GiST is an abbreviation for space-partitioned GiST."* https://www.postgresql.org/docs/16/spgist-intro.html
[^spgist-partition]: Same source. Verbatim: *"SP-GiST supports partitioned search trees, which facilitate development of a wide range of different non-balanced data structures, such as quad-trees, k-d trees, and radix trees (tries). The common feature of these structures is that they repeatedly divide the search space into partitions that need not be of equal size."* https://www.postgresql.org/docs/16/spgist-intro.html
[^spgist-opclasses]: PostgreSQL 16 docs, "SP-GiST — Built-in Operator Classes." Full enumeration of seven built-in opclasses (`box_ops`, `inet_ops`, `kd_point_ops`, `poly_ops`, `quad_point_ops`, `range_ops`, `text_ops`) with indexable operators and KNN ordering operators per row. https://www.postgresql.org/docs/16/spgist-builtin-opclasses.html
[^bloom-intro]: PostgreSQL 16 docs, "bloom contrib extension." Verbatim: *"`bloom` provides an index access method based on Bloom filters."* and *"A Bloom filter is a space-efficient data structure that is used to test whether an element is a member of a set. In the case of an index access method, it allows fast exclusion of non-matching tuples via signatures whose size is determined at index creation."* https://www.postgresql.org/docs/16/bloom.html
[^bloom-signature]: Same source. Verbatim: *"A signature is a lossy representation of the indexed attribute(s), and as such is prone to reporting false positives; that is, it may be reported that an element is in the set, when it is not. So index search results must always be rechecked using the actual attribute values from the heap entry. Larger signatures reduce the odds of a false positive and thus reduce the number of useless heap visits, but of course also make the index larger and hence slower to scan."* https://www.postgresql.org/docs/16/bloom.html
[^bloom-when]: Same source. Verbatim: *"This type of index is most useful when a table has many attributes and queries test arbitrary combinations of them. A traditional btree index is faster than a bloom index, but it can require many btree indexes to support all possible queries where one needs only a single bloom index. Note however that bloom indexes only support equality queries, whereas btree indexes can also perform inequality and range searches."* https://www.postgresql.org/docs/16/bloom.html
[^bloom-params]: Same source. Verbatim `length` (default 80 bits, max 4096, rounded up to nearest 16) and `col1`…`col32` (default 2 bits per column, max 4095) parameter definitions. https://www.postgresql.org/docs/16/bloom.html
[^pg10-hash]: PostgreSQL 10.0 release notes. Verbatim: *"Add write-ahead logging support to hash indexes (Amit Kapila). This makes hash indexes crash-safe and replicatable. The former warning message about their use is removed."* https://www.postgresql.org/docs/release/10.0/
[^pg10-hash-rebuild]: Same source. Verbatim: *"Hash indexes must be rebuilt after pg_upgrade-ing from any previous major PostgreSQL version (Mithun Cy, Robert Haas, Amit Kapila). Major hash index improvements necessitated this requirement. pg_upgrade will create a script to assist with this."* https://www.postgresql.org/docs/release/10.0/
[^pg14-minmax-multi]: PostgreSQL 14.0 release notes. Verbatim: *"Allow BRIN indexes to record multiple min/max values per range (Tomas Vondra). This is useful if there are groups of values in each page range."* https://www.postgresql.org/docs/release/14.0/
[^pg14-bloom]: Same source. Verbatim: *"Allow BRIN indexes to use bloom filters (Tomas Vondra). This allows BRIN indexes to be used effectively with data that is not well-localized in the heap."* https://www.postgresql.org/docs/release/14.0/
[^pg14-spgist-include]: Same source. Verbatim: *"Allow SP-GiST indexes to contain INCLUDE'd columns (Pavel Borisov)."* https://www.postgresql.org/docs/release/14.0/
[^pg15-startswith]: PostgreSQL 15.0 release notes. Verbatim: *"Allow the `^@` starts-with operator and the `starts_with()` function to use btree indexes if using the C collation (Tom Lane). Previously these could only use SP-GiST indexes."* https://www.postgresql.org/docs/release/15.0/
[^pg16-brin-hot]: PostgreSQL 16.0 release notes. Verbatim: *"Allow HOT updates if only BRIN-indexed columns are updated (Matthias van de Meent, Josef Simanek, Tomas Vondra)."* https://www.postgresql.org/docs/release/16.0/
[^pg17-brin-parallel]: PostgreSQL 17.0 release notes. Verbatim: *"Allow BRIN indexes to be created using parallel workers (Tomas Vondra, Matthias van de Meent)."* https://www.postgresql.org/docs/release/17.0/
[^pg17-spgist-incsort]: Same source. Verbatim: *"Allow GiST and SP-GiST indexes to be part of incremental sorts (Miroslav Bendik). This is particularly useful for ORDER BY clauses where the first column has a GiST and SP-GiST index, and other columns do not."* https://www.postgresql.org/docs/release/17.0/
[^pg17-hash-ltree]: Same source. Verbatim: *"Allow the creation of hash indexes on ltree columns (Tommy Pavlicek). This also enables hash join and hash aggregation on ltree columns."* https://www.postgresql.org/docs/release/17.0/
[^pg18-unique-nonbtree]: PostgreSQL 18.0 release notes. Verbatim: *"Allow non-btree unique indexes to be used as partition keys and in materialized views ... The index type must still support equality."* https://www.postgresql.org/docs/release/18.0/

# Full-Text Search


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [tsvector and tsquery Types](#tsvector-and-tsquery-types)
    - [The Match Operator (@@)](#the--match-operator)
    - [tsquery Operators and Precedence](#tsquery-operators-and-precedence)
    - [Vector Construction](#vector-construction)
    - [Query Construction: the Four xxx_to_tsquery Variants](#query-construction-the-four-xxx_to_tsquery-variants)
    - [Ranking: ts_rank vs ts_rank_cd](#ranking-ts_rank-vs-ts_rank_cd)
    - [Highlighting: ts_headline](#highlighting-ts_headline)
    - [Vector Manipulation](#vector-manipulation)
    - [Query Manipulation and Rewriting](#query-manipulation-and-rewriting)
    - [Text Search Configurations](#text-search-configurations)
    - [Dictionaries and Their Ordering](#dictionaries-and-their-ordering)
    - [Parsers and Token Types](#parsers-and-token-types)
    - [Index Choice: GIN vs GiST](#index-choice-gin-vs-gist)
    - [Hard Limits](#hard-limits)
    - [psql Introspection](#psql-introspection)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Reach for this file whenever you need to:

- Add natural-language search to a column
- Replace `WHERE col ILIKE '%foo%'` with something that scales past 100k rows
- Choose between `to_tsquery`, `plainto_tsquery`, `phraseto_tsquery`, and `websearch_to_tsquery` for parsing user input safely
- Decide between GIN and GiST for an FTS column (almost always GIN — quoted verbatim below)
- Index a hot search column without storing the `tsvector` twice (generated column vs expression index)
- Boost titles over bodies via weights `A` / `B` / `C` / `D` and `ts_rank` weight arrays
- Render result snippets with `ts_headline`
- Migrate from a deprecated trigger-maintained `tsvector` to PG12+ generated columns
- Decide between PostgreSQL FTS, [`pg_trgm`](./93-pg-trgm.md) substring/fuzzy similarity, and [`pgvector`](./94-pgvector.md) semantic similarity

For substring/fuzzy/typo-tolerant matching that FTS *cannot* do, see [`93-pg-trgm.md`](./93-pg-trgm.md). For dense-embedding semantic similarity (the "find documents about this topic, even if they share no words" use case), see [`94-pgvector.md`](./94-pgvector.md). For case-insensitive *equality* without all of FTS, see `citext`.


## Mental Model

Four rules drive every decision in this file:

1. **`tsvector` is normalized lexemes, not raw text.** The docs say *"The elements of a `tsvector` are lexemes, which are assumed already normalized, so `rats` does not match `rat`."*[^intro] Stem `running` to `run` at write time *and* at query time using **the same configuration**, or matches silently fail. The `tsvector` type itself does not normalize — *"the `tsvector` type itself does not perform any word normalization; it assumes the words it is given are normalized appropriately for the application."*[^datatype] Always pass raw text through `to_tsvector`.

2. **`tsquery` is the query language, not user input.** Never build a `tsquery` by concatenating user input into `to_tsquery()` — a single stray `&` or unbalanced `(` raises a parse error and you have leaked the parser's wire format to the user. Use `plainto_tsquery`, `phraseto_tsquery`, or `websearch_to_tsquery` for *any* untrusted input. `to_tsquery` is for **programmer-written** queries.

3. **GIN is the default index.** The docs are unambiguous: *"GIN indexes are the preferred text search index type."*[^indexes] GiST is lossy and only competitive for very small datasets or when you must combine `tsvector` with other GiST-indexable columns in one index.

4. **Ranking is opt-in and costs an extra heap fetch per row.** *"Ranking can be expensive since it requires consulting the `tsvector` of each matching document, which can be I/O bound and therefore slow. Unfortunately, it is almost impossible to avoid since practical queries often result in large numbers of matches."*[^controls] Plan ranking against a `LIMIT`, never a full result set.


## Decision Matrix

| You want to… | Use | Avoid | Why |
|---|---|---|---|
| Search natural-language text for words/phrases | `to_tsvector` + GIN + `@@` | `LIKE '%word%'` | Index-able, language-aware stemming; GIN scans are fast even on large tables |
| Accept arbitrary user search input | `websearch_to_tsquery` (or `plainto_tsquery`) | `to_tsquery(user_input)` | `to_tsquery` raises errors on user input; `websearch_to_tsquery` ignores syntax errors silently and supports Google-style `"phrase"` / `OR` / `-term` |
| Index a hot search column | Stored generated column (`GENERATED ALWAYS AS (to_tsvector(...)) STORED`) + GIN | Trigger maintaining a separate column | Generated columns are declarative, PG12+, and obsolete the docs' own trigger recipe[^features] |
| One-off / low-traffic search | GIN on expression index over `to_tsvector(...)` | Storing `tsvector` separately | Saves disk space; requires the same configuration in every query |
| Boost titles over bodies in ranking | `setweight(to_tsvector(title),'A') \|\| setweight(to_tsvector(body),'B')` + `ts_rank(weights, vec, q)` | Two indexes, two queries, `UNION` | Single vector, single index, single sort |
| Substring search (`%postg%` inside `postgresql`) | [`pg_trgm`](./93-pg-trgm.md) GIN/GiST | FTS | FTS works on stemmed lexemes, never on substrings |
| Typo-tolerant fuzzy search | [`pg_trgm`](./93-pg-trgm.md) `similarity()` / `word_similarity()` | FTS dictionaries | FTS dictionary stemming is not a typo corrector |
| Semantic "about this topic" search | [`pgvector`](./94-pgvector.md) | FTS | FTS finds documents sharing *lexemes*; embeddings find documents sharing *meaning* |
| Case-insensitive equality on short fields | `citext` | FTS | citext is `=` only; FTS is for documents |
| Render snippets with terms highlighted | `ts_headline` | Custom regex | `ts_headline` knows phrase boundaries; but see XSS warning below |
| Find documents containing a phrase | `phraseto_tsquery` or `websearch_to_tsquery('"exact phrase"')` | `to_tsquery('word1 & word2')` | Phrase needs `<->` (FOLLOWED BY), not `&` |


## Syntax / Mechanics


### tsvector and tsquery Types

A `tsvector` is *"a sorted list of distinct lexemes"*[^datatype]. Each lexeme can carry **positions** (1–16383) and a single-letter **weight** (A / B / C / D).[^datatype] The literal form looks like:

    -- Plain lexemes, no positions, no weights
    SELECT 'fat rat'::tsvector;
    -- => 'fat' 'rat'

    -- Lexemes with positions
    SELECT 'a fat cat sat on a mat'::tsvector;
    -- => 'a':1,6 'cat':3 'fat':2 'mat':7 'on':5 'sat':4

    -- Lexemes with positions + weights
    SELECT $$'cat':1A 'fat':2B,3A 'mat':4D$$::tsvector;

The `D` weight is the default and *"is not shown on output"*.[^datatype] Lexemes are deduplicated and sorted at input time:

> *"Sorting and duplicate-elimination are done automatically during input."*[^datatype]

A `tsquery` *"stores lexemes that are to be searched for, and can combine them using the Boolean operators `&` (AND), `|` (OR), and `!` (NOT), as well as the phrase search operator `<->` (FOLLOWED BY)."*[^datatype] Lexemes can carry weight restrictions and a `:*` prefix suffix:

    SELECT 'fat & (rat | cat)'::tsquery;
    SELECT 'fat:AB & cat:A'::tsquery;       -- match only when lexeme weight is A or B
    SELECT 'postg:*'::tsquery;              -- prefix match: 'postgres', 'postgresql', ...

> [!NOTE] PostgreSQL 14
> Several `to_tsquery()` and `websearch_to_tsquery()` parser bugs were fixed where discarded tokens (e.g., underscores) produced wrong phrase output. *"`websearch_to_tsquery('"pg_class pg"')` and `to_tsquery('pg_class <-> pg')` used to output `('pg' & 'class') <-> 'pg'`, but now both output `'pg' <-> 'class' <-> 'pg'`."*[^pg14-discard]


### The Match Operator (`@@`)

Three forms, all return `boolean`:[^functions]

| Signature | Behavior |
|---|---|
| `tsvector @@ tsquery` | true if vector matches query |
| `tsquery @@ tsvector` | same (arguments can be reversed) |
| `text @@ tsquery` | implicitly applies `to_tsvector(default_text_search_config, text)` to the text |

The docs say *"It doesn't matter which data type is written first"* for vector/query order.[^intro] The deprecated synonym `@@@` is also accepted but should be considered a historical wart.

The `text @@ tsquery` short form uses `default_text_search_config` to lex the left operand at *every call*. **This defeats indexing** — the optimizer cannot match the predicate to a precomputed `tsvector` column or expression index unless the expression on the left side is *exactly* what the index is built on. Always index `to_tsvector(<config>, text)` explicitly and write queries against that.


### tsquery Operators and Precedence

From `datatype-textsearch.html`:

> *"In the absence of parentheses, `!` (NOT) binds most tightly, `<->` (FOLLOWED BY) next most tightly, then `&` (AND), with `|` (OR) binding the least tightly."*[^datatype]

| Operator | Meaning | Example |
|---|---|---|
| `&` | AND | `fat & cat` |
| `\|` | OR | `fat \| cat` |
| `!` | NOT | `!cat` |
| `<->` | FOLLOWED BY immediately (distance 1) | `'foo' <-> 'bar'` |
| `<N>` | FOLLOWED BY at exactly distance N | `'foo' <2> 'bar'` |
| `:*` | prefix match | `postg:*` |
| `:A`, `:B`, `:C`, `:D` | weight restriction | `fat:AB & cat:A` |

`tsquery <-> tsquery` and `tsquery_phrase(q1, q2, dist)` are constructor functions that produce a phrase `tsquery` from two existing queries.[^features] The match distance in `<N>` *"cannot be more than 16,384"*[^limits].


### Vector Construction

The default constructor:[^controls]

    to_tsvector([config regconfig,] document text) RETURNS tsvector

> *"`to_tsvector` parses a textual document into tokens, reduces the tokens to lexemes, and returns a `tsvector` which lists the lexemes together with their positions in the document."*[^controls]

Other constructors:[^functions]

| Function | Behavior |
|---|---|
| `to_tsvector([cfg,] document text)` | text → normalized vector with positions |
| `to_tsvector([cfg,] document json)` | concatenates all string values in document order |
| `to_tsvector([cfg,] document jsonb)` | same; "document order" is implementation-dependent for `jsonb` |
| `array_to_tsvector(text[])` | array elements used as lexemes **as-is**, no normalization; empties and NULLs forbidden |
| `json_to_tsvector([cfg,] doc, filter jsonb)` | filter is jsonb array of `"string"`/`"numeric"`/`"boolean"`/`"key"`/`"all"` |
| `jsonb_to_tsvector(...)` | same |

> [!WARNING] `array_to_tsvector` accepts unnormalized input
> The PG15 docs added a runtime check: *"Generate an error if `array_to_tsvector()` is passed an empty-string array element."*[^pg15-array] Pre-PG15 callers that stored empty strings can produce dump/restore failures.

Setting weights at construction time is the canonical pattern:

    SELECT setweight(to_tsvector('english', coalesce(title, '')), 'A')
        || setweight(to_tsvector('english', coalesce(body,  '')), 'B') AS doc_tsv;

> *"Weight labels apply to positions, not lexemes. If the input vector has been stripped of positions then `setweight` does nothing."*[^features]


### Query Construction: the Four xxx_to_tsquery Variants

Each accepts an optional `config regconfig` first argument; the same configuration must match the one used to build the indexed vector.

**`to_tsquery(querytext)`** — programmer input only. *"`querytext` must consist of single tokens separated by the `tsquery` operators `&` (AND), `|` (OR), `!` (NOT), and `<->` (FOLLOWED BY), possibly grouped using parentheses."*[^controls] Any other input raises a syntax error.

**`plainto_tsquery(querytext)`** — *"transforms the unformatted text querytext to a `tsquery` value. The text is parsed and normalized much as for `to_tsvector`, then the `&` (AND) `tsquery` operator is inserted between surviving words."*[^controls] All terms must appear; stop words are dropped silently. No phrase semantics.

**`phraseto_tsquery(querytext)`** — *"behaves much like `plainto_tsquery`, except that it inserts the `<->` (FOLLOWED BY) operator between surviving words instead of the `&` (AND) operator. Also, stop words are not simply discarded, but are accounted for by inserting `<N>` operators rather than `<->` operators."*[^controls] So `'the quick fox'` becomes `'quick' <2> 'fox'` (one stopword skipped).

**`websearch_to_tsquery(querytext)`** — Google-style. Per the docs: *"Quoted word sequences are converted to phrase tests. The word 'or' is understood as producing an OR operator, and a dash produces a NOT operator; other punctuation is ignored. This approximates the behavior of some common web search tools."*[^functions]

| Input | `websearch_to_tsquery('english', ...)` |
|---|---|
| `the fat cat` | `'fat' & 'cat'` |
| `"fat cat"` | `'fat' <-> 'cat'` |
| `fat OR rat` | `'fat' \| 'rat'` |
| `cat -hat` | `'cat' & !'hat'` |
| `f(&` | `''` (syntax errors silently ignored) |

For untrusted user input, `websearch_to_tsquery` is the right default. It never raises an error on garbage input and produces sensible queries for natural prose with quotes.

> [!NOTE] PostgreSQL 14
> Multiple-discarded-tokens-in-quotes parser fix: *"`websearch_to_tsquery('"aaa: bbb"')` used to output `'aaa' <2> 'bbb'`, but now outputs `'aaa' <-> 'bbb'`."*[^pg14-discard]


### Ranking: ts_rank vs ts_rank_cd

Both signatures:[^controls]

    ts_rank   ([weights float4[],] vector tsvector, query tsquery [, normalization int]) RETURNS float4
    ts_rank_cd([weights float4[],] vector tsvector, query tsquery [, normalization int]) RETURNS float4

`ts_rank` is term-frequency-based. `ts_rank_cd` is *"cover density"*: *"the proximity of matching lexemes to each other is taken into consideration."*[^controls] Reference paper: *"Clarke, Cormack, and Tudhope's 'Relevance Ranking for One to Three Term Queries' in the journal 'Information Processing and Management', 1999."*[^controls]

Weight array (D, C, B, A in that order, matching tsvector weights inversely):[^controls]

> *"The weight arrays specify how heavily to weigh each category of word, in the order: {D-weight, C-weight, B-weight, A-weight}. If no weights are provided, then these defaults are used: {0.1, 0.2, 0.4, 1.0}."*

Normalization integer is a bitmask (OR them together):[^controls]

| Bit | Effect |
|---|---|
| 0 | "ignores the document length" (default) |
| 1 | "divides the rank by 1 + the logarithm of the document length" |
| 2 | "divides the rank by the document length" |
| 4 | "divides the rank by the mean harmonic distance between extents (this is implemented only by `ts_rank_cd`)" |
| 8 | "divides the rank by the number of unique words in document" |
| 16 | "divides the rank by 1 + the logarithm of the number of unique words in document" |
| 32 | "divides the rank by itself + 1" |

> [!WARNING] Ranking is expensive
> Verbatim: *"Ranking can be expensive since it requires consulting the `tsvector` of each matching document, which can be I/O bound and therefore slow."*[^controls] Always restrict by `@@` *first*, then ORDER BY rank, then LIMIT. Never rank a full table.


### Highlighting: ts_headline

    ts_headline([config regconfig,] document text, query tsquery [, options text]) RETURNS text

Returns *"an excerpt from the document in which terms from the query are highlighted."*[^controls] Options are a comma-separated string of `Name=Value` pairs:

| Option | Default | Description |
|---|---|---|
| `MaxWords` | 35 | longest headline |
| `MinWords` | 15 | shortest headline |
| `ShortWord` | 3 | drop words this short at boundaries unless they are query terms |
| `HighlightAll` | false | use the entire document |
| `MaxFragments` | 0 | 0 = single non-fragment headline; >0 enables fragment-based mode |
| `StartSel` | `<b>` | wrap-open for match |
| `StopSel` | `</b>` | wrap-close for match |
| `FragmentDelimiter` | `" ... "` | only when `MaxFragments > 0` |

> [!WARNING] ts_headline XSS risk
> Verbatim from the docs: *"The output from `ts_headline` is not guaranteed to be safe for direct inclusion in web pages. When `HighlightAll` is `false` (the default), some simple XML tags are removed from the document, but this is not guaranteed to remove all HTML markup. Therefore, this does not provide an effective defense against attacks such as cross-site scripting (XSS) attacks, when working with untrusted input. To guard against such attacks, all HTML markup should be removed from the input document, or an HTML sanitizer should be used on the output."*[^controls]

> [!NOTE] PostgreSQL 16
> *"Improve the handling of full text highlighting function `ts_headline()` for `OR` and `NOT` expressions."*[^pg16-headline]

> *"`ts_headline` uses the original document, not a `tsvector` summary, so it can be slow and should be used with care."*[^controls]


### Vector Manipulation

| Function | Returns | Behavior |
|---|---|---|
| `setweight(v tsvector, w "char")` | tsvector | label every position with weight A/B/C/D[^features] |
| `setweight(v, w, lexemes text[])` | tsvector | label only listed lexemes |
| `length(v tsvector)` | int | *"the number of lexemes stored in the vector"*[^features] |
| `strip(v tsvector)` | tsvector | remove positions and weights — *"the `<->` operator will never match stripped input"*[^features] |
| `ts_delete(v, lexeme text)` | tsvector | remove any occurrence of lexeme |
| `ts_delete(v, lexemes text[])` | tsvector | remove any of multiple lexemes |
| `ts_filter(v, weights "char"[])` | tsvector | keep only listed weights |
| `v1 \|\| v2` | tsvector | concatenate; positions in v2 are offset past v1's max position[^features] |
| `tsvector_to_array(v)` | text[] | extract lexemes (loses position/weight) |
| `unnest(v)` | setof (lexeme text, positions smallint[], weights text) | one row per lexeme |

> [!NOTE] PostgreSQL 15
> *"Ignore NULL array elements in `ts_delete()` and `setweight()` functions with array arguments."*[^pg15-array]


### Query Manipulation and Rewriting

| Function | Returns | Behavior |
|---|---|---|
| `q1 && q2` | tsquery | AND-combine[^functions] |
| `q1 \|\| q2` | tsquery | OR-combine |
| `!! q` | tsquery | negate |
| `q1 <-> q2` | tsquery | construct phrase query (distance 1) |
| `tsquery_phrase(q1, q2 [, distance])` | tsquery | construct phrase query with explicit distance[^features] |
| `q1 @> q2` | bool | does q1 contain q2's lexemes (operators ignored) |
| `q1 <@ q2` | bool | reverse |
| `numnode(q)` | int | nodes (lexemes + operators); 0 means stop-words-only[^features] |
| `querytree(q)` | text | indexable portion; result `""` or `T` means non-indexable[^features] |
| `ts_rewrite(q, target, substitute)` | tsquery | replace target subtree with substitute |
| `ts_rewrite(q, select_sql text)` | tsquery | iterate rewrite rules from an SQL SELECT returning (target, substitute) pairs[^features] |


### Text Search Configurations

A configuration ties together a **parser** and a list of **dictionaries** per token type. *"A text search configuration specifies all options necessary to transform a document into a `tsvector`: the parser to use to break text into tokens, and the dictionaries to use to transform each token into a lexeme."*[^config]

The `default_text_search_config` GUC names the configuration used when callers omit it. *"It can be set in `postgresql.conf`, or set for an individual session using the `SET` command."*[^config] Discover it at runtime via `get_current_ts_config()`.

`CREATE TEXT SEARCH CONFIGURATION` grammar:[^createconfig]

    CREATE TEXT SEARCH CONFIGURATION name (
        PARSER = parser_name |
        COPY = source_config
    )

Almost always copy from a built-in (e.g., `english`, `simple`) and then `ALTER ... ALTER MAPPING FOR <tokens> WITH <dicts>` to substitute dictionaries.


### Dictionaries and Their Ordering

`CREATE TEXT SEARCH DICTIONARY` grammar:[^createdict]

    CREATE TEXT SEARCH DICTIONARY name (
        TEMPLATE = template
        [, option = value [, ... ]]
    )

A dictionary applied to a token returns one of:

- an **array of lexemes** if it knows the token
- **a single-element array + filter flag** if it is a filtering dict (e.g., `unaccent`) — pass through to the next dict
- **empty array `{}`** if the token is a stop word — discard
- **NULL** if the token is unknown — try the next dict

Built-in templates:[^dicts]

| Template | Use |
|---|---|
| `simple` | lowercase + stop word file; if `Accept = true` (default), greedily consumes — *"it is only useful to place a `simple` dictionary at the end of a list of dictionaries"*[^dicts] |
| `synonym` | one-word-to-one-word; supports `*` suffix for prefix |
| `thesaurus` | phrase-aware synonym (extension of synonym); *"requires reindexing"* on parameter changes[^dicts] |
| `ispell` | morphological (MySpell/Hunspell formats); *"should be followed by another broader dictionary"*[^dicts] |
| `snowball` | language-aware stemming; *"recognizes everything ... should be placed at the end"*[^dicts] |
| `unaccent` (extension) | filtering dict that strips diacritics; output passes to next dict[^unaccent] |

**The general ordering rule**, verbatim:[^dicts]

> *"The general rule for configuring a list of dictionaries is to place first the most narrow, most specific dictionary, then the more general dictionaries, finishing with a very general dictionary, like a Snowball stemmer or `simple`, which recognizes everything."*

A typical English chain: `unaccent` (filter) → `english_ispell` (morphological) → `english_stem` (Snowball fallback).

> [!WARNING] Dictionary files must be UTF-8
> Verbatim: *"Most types of dictionaries rely on configuration files, such as files of stop words. These files must be stored in UTF-8 encoding."*[^dicts] Dictionary file changes also require `ALTER TEXT SEARCH DICTIONARY` to force backends to reload.

> [!NOTE] PostgreSQL 14
> Stemming added for Armenian, Basque, Catalan, Hindi, Serbian, and Yiddish.[^pg14-langs] Tsearch data files also gained unlimited line length: *"The previous limit was 4K bytes."*[^pg14-readline]

> [!NOTE] PostgreSQL 17
> *"Allow unaccent character translation rules to contain whitespace and quotes ... The syntax for the `unaccent.rules` file has changed."*[^pg17-unaccent]

> [!NOTE] PostgreSQL 18
> Full-text search and `pg_trgm` now use the cluster's default collation provider to read configuration files and dictionaries, not always libc. *"Clusters that default to non-libc collation providers (e.g., ICU, builtin) that behave differently than libc for characters processed by LC_CTYPE could observe changes in behavior of some full-text search functions, as well as the pg_trgm extension. When upgrading such clusters using pg_upgrade, it is recommended to reindex all indexes related to full-text search and pg_trgm after the upgrade."*[^pg18-cfg] Also: Estonian stemming added.[^pg18-est]


### Parsers and Token Types

The built-in parser `pg_catalog.default` recognizes 23 token types. The most important when picking dictionaries:[^parsers]

| Alias | Use case |
|---|---|
| `asciiword` | plain ASCII word |
| `word` | letters word (any script) |
| `numword` | letters + digits (`beta1`) |
| `asciihword` / `hword` | hyphenated, ASCII / any letters |
| `hword_asciipart` / `hword_part` / `hword_numpart` | components of a hyphenated word |
| `email`, `protocol`, `url`, `host`, `url_path`, `file` | technical tokens — useful to map to `simple` so they index verbatim |
| `int`, `uint`, `float`, `sfloat`, `version` | numeric tokens |
| `tag`, `entity`, `blank` | XML/HTML markup, whitespace |

> *"The parser's notion of a 'letter' is determined by the database's locale setting, specifically `lc_ctype`."*[^parsers]

Hyphenated input emits both the whole word and each part as overlapping tokens, so e.g. `up-to-date` produces matches for both the compound and the parts.[^parsers]


### Index Choice: GIN vs GiST

| Property | GIN | GiST |
|---|---|---|
| Recommended? | **Yes** — *"the preferred text search index type"*[^indexes] | Only for small datasets, or when combining with other GiST-indexable columns |
| Lossy? | Non-lossy (no recheck of `@@`) | *"A GiST index is lossy, meaning that the index might produce false matches, and it is necessary to check the actual table row to eliminate such false matches."*[^indexes] |
| Stores | lexeme posting lists | signature bitmap (default `siglen = 124`, max `2024`)[^indexes] |
| Index build | sensitive to `maintenance_work_mem` (helps a lot) | not sensitive |
| Index size | larger | smaller (signatures) |
| Updates | slower without `fastupdate` | faster |
| Weight queries | GIN stores no weight labels — query-by-weight always rechecks the heap[^indexes] | same |

Canonical declaration:

    CREATE INDEX docs_search_idx ON docs USING gin(doc_tsv);

The operator class is `tsvector_ops` (the default; no need to name it). It supports `@@` and the deprecated synonym `@@@`.[^gin-ops]

> [!NOTE] PostgreSQL 18
> *"Allow parallel CREATE INDEX for GIN indexes"* — GIN builds, including FTS indexes, can now use parallel workers.[^pg18-paral]


### Hard Limits

From `textsearch-limitations.html`, every limit verbatim:[^limits]

- *"The length of each lexeme must be less than 2 kilobytes"*
- *"The length of a `tsvector` (lexemes + positions) must be less than 1 megabyte"*
- *"The number of lexemes must be less than 2^64"*
- *"Position values in `tsvector` must be greater than 0 and no more than 16,383"*
- *"The match distance in a `<N>` (FOLLOWED BY) `tsquery` operator cannot be more than 16,384"*
- *"No more than 256 positions per lexeme"*
- *"The number of nodes (lexemes + operators) in a `tsquery` must be less than 32,768"*

The 16,383 position cap is silent: *"Position values can range from 1 to 16383; larger numbers are silently set to 16383."*[^datatype] After lexeme 16,383, positions stop being trackable — phrase search across very long documents stops working.

The 256-positions-per-lexeme rule combined with `<->` means a word appearing 257+ times in a document will only carry the first 256 positions; phrase search can miss subsequent occurrences. For documents that exceed these limits, split into smaller documents (chapter / paragraph rows) before indexing.


### psql Introspection

| Command | Purpose |
|---|---|
| `\dF[+]` | list text search configurations |
| `\dFd[+]` | list dictionaries |
| `\dFp[+]` | list parsers |
| `\dFt[+]` | list templates |

Each accepts an optional `PATTERN` and a `+` for detail.[^psql]


## Examples / Recipes


### Recipe 1: Baseline searchable column with generated tsvector

The canonical pattern. Generated column (see [`01-syntax-ddl.md`](./01-syntax-ddl.md) for generated-column syntax and constraints), GIN, English configuration.

    CREATE TABLE articles (
        id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        title        text NOT NULL,
        body         text NOT NULL,
        published_at timestamptz NOT NULL DEFAULT now(),
        doc_tsv      tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(body,  '')), 'B')
        ) STORED
    );

    CREATE INDEX articles_doc_tsv_idx ON articles USING gin(doc_tsv);

Query:

    SELECT id, title, ts_rank(doc_tsv, q) AS rank
    FROM   articles, websearch_to_tsquery('english', $1) q
    WHERE  doc_tsv @@ q
    ORDER  BY rank DESC
    LIMIT  20;

The `coalesce(..., '')` is required — `to_tsvector(NULL)` returns NULL and the concatenation would produce NULL.[^features]


### Recipe 2: Expression index without storing the vector

When disk space matters and you accept tying every query to the same configuration:

    CREATE INDEX articles_search_idx ON articles
        USING gin(to_tsvector('english', title || ' ' || body));

    -- Query MUST repeat the same expression
    SELECT id, title
    FROM   articles
    WHERE  to_tsvector('english', title || ' ' || body) @@ websearch_to_tsquery('english', $1);

The docs:[^tables]

> *"One advantage of the separate-column approach over an expression index is that it is not necessary to explicitly specify the text search configuration in queries in order to make use of the index. ... Another advantage is that searches will be faster, since it will not be necessary to redo the `to_tsvector` calls to verify index matches. The expression-index approach is simpler to set up, however, and it requires less disk space since the `tsvector` representation is not stored explicitly."*


### Recipe 3: User input → safe tsquery

Never trust user input through `to_tsquery`. Use `websearch_to_tsquery` for Google-style input, `plainto_tsquery` for "all words, no syntax" mode, `phraseto_tsquery` for "exact phrase only":

    -- Google-style (default for search UIs)
    SELECT websearch_to_tsquery('english', $1);

    -- Strict "all of these words"
    SELECT plainto_tsquery('english', $1);

    -- Strict "this exact phrase"
    SELECT phraseto_tsquery('english', $1);

If the input could be empty after stop-word removal (e.g., `"the and"`), `numnode(q) = 0` lets the caller short-circuit:[^features]

    WITH q AS (SELECT websearch_to_tsquery('english', $1) AS q)
    SELECT id, title
    FROM articles, q
    WHERE numnode(q.q) > 0
      AND doc_tsv @@ q.q
    LIMIT 50;


### Recipe 4: Weighted ranking with custom boost

Boost rare terms in the title 5x over the body:

    SELECT id, title,
           ts_rank('{0.05, 0.1, 0.3, 1.0}'::float4[], doc_tsv, q, 32) AS rank
    FROM   articles, websearch_to_tsquery('english', $1) q
    WHERE  doc_tsv @@ q
    ORDER  BY rank DESC
    LIMIT  20;

Weight array order is `{D, C, B, A}`. The trailing `32` is the normalization bitmask: *"divides the rank by itself + 1"* (squashes scores into `[0, 1)`).[^controls]


### Recipe 5: Cover-density ranking (proximity matters)

Use `ts_rank_cd` when the user's intent is "find documents where these words appear close together":

    SELECT id, title,
           ts_rank_cd(doc_tsv, q, 4|32) AS rank      -- 4 = harmonic distance, 32 = squash
    FROM   articles, websearch_to_tsquery('english', $1) q
    WHERE  doc_tsv @@ q
    ORDER  BY rank DESC
    LIMIT  20;

Normalization bit `4` is the only one *"implemented only by `ts_rank_cd`"*.[^controls]


### Recipe 6: Snippet highlighting with ts_headline

Return a 30-word excerpt with `<mark>` around each match:

    SELECT id, title,
           ts_headline(
               'english', body, q,
               'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=15, ShortWord=3, MaxFragments=2, FragmentDelimiter=" … "'
           ) AS snippet
    FROM   articles, websearch_to_tsquery('english', $1) q
    WHERE  doc_tsv @@ q
    ORDER  BY ts_rank(doc_tsv, q) DESC
    LIMIT  10;

Pair with the XSS hardening rule above: sanitize `body` before storing it or sanitize `snippet` before rendering.


### Recipe 7: Audit — every tsvector column without a GIN index

Find tables that have a `tsvector` column but no GIN or GiST index covering it:

    SELECT n.nspname  AS schema,
           c.relname  AS table_name,
           a.attname  AS column_name
    FROM   pg_attribute a
    JOIN   pg_class     c ON c.oid = a.attrelid
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   pg_type      t ON t.oid = a.atttypid
    WHERE  c.relkind IN ('r', 'p')
      AND  t.typname = 'tsvector'
      AND  NOT a.attisdropped
      AND  NOT EXISTS (
              SELECT 1
              FROM   pg_index i
              JOIN   pg_am am ON am.oid = (SELECT relam FROM pg_class WHERE oid = i.indexrelid)
              WHERE  i.indrelid = a.attrelid
                AND  am.amname IN ('gin', 'gist')
                AND  a.attnum = ANY(i.indkey)
          )
    ORDER BY 1, 2, 3;

Continues the iteration-15/19 audit-recipe pattern. See [`64-system-catalogs.md`](./64-system-catalogs.md) for the catalog graph.


### Recipe 8: Migrate from trigger-maintained tsvector to generated column

Pre-PG12 code typically maintained the `tsvector` with `tsvector_update_trigger`. The docs explicitly mark this obsolete:[^features]

> *"The method described in this section has been obsoleted by the use of stored generated columns, as described in Section 12.2.2."*

Migration:

    -- 1. Add the new generated column with a temporary name
    ALTER TABLE articles
        ADD COLUMN doc_tsv_new tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(body,  '')), 'B')
        ) STORED;

    -- 2. Drop trigger and old indexed column inside a brief transaction
    BEGIN;
        DROP TRIGGER articles_tsv_trg ON articles;
        DROP INDEX  articles_doc_tsv_idx;
        ALTER TABLE articles DROP COLUMN doc_tsv;
        ALTER TABLE articles RENAME COLUMN doc_tsv_new TO doc_tsv;
    COMMIT;

    -- 3. Rebuild the GIN index
    CREATE INDEX CONCURRENTLY articles_doc_tsv_idx ON articles USING gin(doc_tsv);


### Recipe 9: Multi-language column

Store the language alongside the document, generate the vector against the per-row language:

    CREATE TABLE multi_lang_docs (
        id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        lang     regconfig NOT NULL DEFAULT 'english',
        body     text NOT NULL,
        body_tsv tsvector GENERATED ALWAYS AS (to_tsvector(lang, body)) STORED
    );

    CREATE INDEX multi_lang_docs_tsv_idx ON multi_lang_docs USING gin(body_tsv);

Query selecting the same config:

    SELECT id, body
    FROM   multi_lang_docs
    WHERE  body_tsv @@ to_tsquery(lang, $1);


### Recipe 10: Indexing JSON fields

`jsonb_to_tsvector` flattens all string values:

    CREATE INDEX events_payload_tsv_idx
        ON events
        USING gin( jsonb_to_tsvector('english', payload, '["string"]'::jsonb) );

    SELECT id
    FROM   events
    WHERE  jsonb_to_tsvector('english', payload, '["string"]'::jsonb) @@ websearch_to_tsquery('english', $1);

The filter argument selects which JSON value types contribute (`"string"`, `"numeric"`, `"boolean"`, `"key"`, `"all"`).[^functions]


### Recipe 11: Filter then rank (the only correct pattern)

The optimizer must use the GIN index for `@@` and only compute `ts_rank` against the *small* matching set. Always have a `WHERE` clause that the index can evaluate; never put `ts_rank > N` in a `WHERE` clause (rank cannot be computed before fetching the row):

    -- CORRECT: GIN does the filter, rank is per-match
    SELECT id, title, ts_rank(doc_tsv, q) AS rank
    FROM   articles, websearch_to_tsquery('english', $1) q
    WHERE  doc_tsv @@ q
    ORDER  BY rank DESC
    LIMIT  20;

    -- WRONG: forces a sequential scan
    SELECT id, title, ts_rank(doc_tsv, websearch_to_tsquery('english', $1)) AS rank
    FROM   articles
    ORDER  BY rank DESC
    LIMIT  20;


### Recipe 12: Phrase search with quoted user input

`websearch_to_tsquery` handles quotes:

    SELECT id, title
    FROM   articles
    WHERE  doc_tsv @@ websearch_to_tsquery('english', '"machine learning" AND embeddings');

Equivalent to `'machine' <-> 'learning' & embeddings`.

For programmer-built phrases:

    SELECT 'machine' <-> 'learning';     -- tsquery: 'machine' <-> 'learning'
    SELECT tsquery_phrase('machine'::tsquery, 'learning'::tsquery, 3);
    -- => 'machine' <3> 'learning'


### Recipe 13: Stop-word-only query short-circuit

A query like `"the of and"` produces an empty `tsquery` (zero nodes) and matches **every** indexed row in a scan-the-world disaster. Short-circuit on `numnode = 0`:

    WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tq)
    SELECT id, title
    FROM   articles, q
    WHERE  numnode(q.tq) > 0
      AND  doc_tsv @@ q.tq
    LIMIT  50;

Or use `querytree` and check for `''` / `'T'`:[^features]

    SELECT querytree('the & of'::tsquery);   -- => ''       (non-indexable)


### Recipe 14: Custom configuration that preserves URLs

The built-in `english` config drops `host` / `url` / `url_path` tokens through `simple_stem` / `english_stem`. To make URLs searchable verbatim, copy the config and route URL token types to a dedicated `simple` dictionary:

    CREATE TEXT SEARCH CONFIGURATION docs_en (COPY = english);

    ALTER TEXT SEARCH CONFIGURATION docs_en
        ALTER MAPPING FOR host, url, url_path, email
        WITH simple;

    -- now to_tsvector('docs_en', 'see https://example.com/path/to/doc') stores 'example.com', '/path/to/doc'

Use `docs_en` in both the generated column and the query.


### Recipe 15: Test what a query is going to do

`ts_debug` shows every token's parser type and the dictionary chain it traversed:

    SELECT * FROM ts_debug('english', 'The quick-brown fox jumped.');

Returns one row per token with the matched dictionary and the lexemes it produced (or `{}` for stop words, `NULL` for unknowns).[^debug]

Test a single token through a single dictionary:

    SELECT ts_lexize('english_stem', 'running');   -- => {run}
    SELECT ts_lexize('english_stem', 'the');       -- => {}     (stop word)
    SELECT ts_lexize('english_stem', 'xyzqq');     -- => NULL   (unknown)


### Recipe 16: Decision wrapper — FTS vs pg_trgm vs pgvector

A SQL function that returns the recommended strategy based on input shape:

| Input shape | Strategy |
|---|---|
| `"machine learning embeddings"` (natural prose, words you'd see in a body) | FTS — `websearch_to_tsquery` + `doc_tsv @@ q` |
| `"postgr"` (prefix or substring) | pg_trgm — `name % $1` |
| `"howw to deplooy postgress"` (typos) | pg_trgm — `similarity(name, $1) > 0.4` |
| `"how do I make my database faster?"` (intent, not keywords) | pgvector — `embedding <=> $1::vector` |

Pick at the application layer — there's no single in-DB query that does all three well. See [`93-pg-trgm.md`](./93-pg-trgm.md) and [`94-pgvector.md`](./94-pgvector.md).


## Gotchas / Anti-patterns

1. **`LIKE '%word%'` doesn't compete.** FTS is index-able; `LIKE '%word%'` is a sequential scan. The right substitute when you need *substring* (not word) matching is the `pg_trgm` extension's GIN/GiST trigram index, not FTS.

2. **`to_tsquery(user_input)` raises errors on user input.** A single unbalanced `(` or stray `&` from a user blows up the query. Use `websearch_to_tsquery` (silently absorbs syntax errors) or `plainto_tsquery`. `to_tsquery` is for programmer-written queries only.

3. **Different config at write time vs query time silently fails.** Indexing with `to_tsvector('english', ...)` and querying `to_tsvector('simple', ...) @@ ...` produces no matches and no error — both sides must agree on configuration. Tying configuration to a generated column (Recipe 1) eliminates this class of bug.

4. **`text @@ tsquery` defeats the index.** The convenience operator runs `to_tsvector(default_text_search_config, text)` per row. Always write `doc_tsv @@ q` against the same expression as your index.

5. **`ts_rank(...) > X` in `WHERE` forces a full scan.** Rank cannot be evaluated before the row is fetched. Apply `@@` in `WHERE`, then `ORDER BY rank DESC LIMIT N`. (Recipe 11.)

6. **`tsvector` is duplicate-eliminated; `tsvector` is *order-independent*.** `'foo bar'::tsvector` and `'bar foo'::tsvector` are equal. Phrase order is reconstructed from positions, not from input order — strip them with `strip()` and `<->` matching breaks.[^features]

7. **`strip()` kills phrase search.** *"The `<->` (FOLLOWED BY) `tsquery` operator will never match stripped input, since it cannot determine the distance between lexeme occurrences."*[^features]

8. **Position cap is 16,383, silently.** *"larger numbers are silently set to 16383"*[^datatype]. A 50,000-word document loses position data past word 16,383, breaking phrase search on the tail.

9. **256 positions per lexeme.** A word appearing 1,000 times in a document keeps only the first 256 positions for phrase matching.[^limits]

10. **Stop-word-only queries return zero matches in fault-tolerant variants — but match every row in `to_tsquery`'s strict variant.** `websearch_to_tsquery('the and')` yields an empty tsquery; `doc_tsv @@ q` is then always false for vectors, true on every match for some implementations of optimizer rewriting. Short-circuit with `numnode(q) > 0` (Recipe 13).

11. **GIN index does not store weight labels.** Queries that filter by lexeme weight (`'fat:A'::tsquery`) must recheck the heap for every candidate row. The GIN docs:[^indexes] this is intentional but limits the speedup.

12. **GiST is lossy for FTS — verify the actual table row.** *"A GiST index is lossy ... it is necessary to check the actual table row to eliminate such false matches."*[^indexes] On large datasets this defeats GiST's smaller index size.

13. **`ts_headline` reads the raw text, not the `tsvector`.** It re-parses each candidate row's `body` column. With `LIMIT 1000` ordered by rank it can read 1,000 multi-KB rows. Limit `ts_headline` to the page you return.

14. **`ts_headline` is not XSS-safe.** Verbatim: *"this does not provide an effective defense against attacks such as cross-site scripting (XSS) attacks, when working with untrusted input."*[^controls] Sanitize input or output.

15. **Trigger-maintained tsvector is obsolete.** *"The method described in this section has been obsoleted by the use of stored generated columns."*[^features] Don't add new trigger-based maintenance; migrate as in Recipe 8.

16. **Snowball/English stem files must be UTF-8.** *"These files must be stored in UTF-8 encoding."*[^dicts] Latin-1 files load but give silent garbage results.

17. **Thesaurus changes require reindexing.** *"Thesauruses are used during indexing so any change in the thesaurus dictionary's parameters requires reindexing."*[^dicts] Adding a new synonym set to a deployed thesaurus is a full-table `REINDEX` event.

18. **Configuration changes break expression indexes.** `ALTER TEXT SEARCH CONFIGURATION ... ALTER MAPPING` changes the output of `to_tsvector(cfg, text)`. Any expression index built on that function call is silently stale until rebuilt. Stored generated columns regenerate row-by-row only on `ALTER TABLE` operations; consider a controlled re-emit (e.g., `UPDATE t SET title = title` on a chunked batch).

19. **`array_to_tsvector` does not normalize.** It uses array elements as lexemes verbatim. Use `to_tsvector` instead when you have words, not pre-computed lexemes.

20. **`@@@` is deprecated.** It works (it's still in the `tsvector_ops` operator class[^gin-ops]) but is a synonym for `@@` and should not appear in new code.

21. **Dictionary file edits do not affect existing sessions.** *"Normally, a database session will read a dictionary configuration file only once, when it is first used within the session. If you modify a configuration file and want to force existing sessions to pick up the new contents, issue an `ALTER TEXT SEARCH DICTIONARY` command on the dictionary."*[^dicts]

22. **`citext`, `pg_trgm`, and FTS are not interchangeable.** FTS normalizes to language-stems (so `cats` matches `cat`). `pg_trgm` finds substring/fuzzy matches at the character level (so `cats` matches nothing about `feline`). `citext` is just lowercased equality. See the decision matrix above and routes to [`93-pg-trgm.md`](./93-pg-trgm.md) / [`94-pgvector.md`](./94-pgvector.md).


## See Also

- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — generated column syntax (`GENERATED ALWAYS AS ... STORED`) and DDL constraints
- [`16-arrays.md`](./16-arrays.md) — `tsvector_to_array` and array of lexemes
- [`17-json-jsonb.md`](./17-json-jsonb.md) — `jsonb_to_tsvector` for indexing JSON payloads
- [`22-indexes-overview.md`](./22-indexes-overview.md) — when FTS sits in the index-decision tree
- [`24-gin-gist-indexes.md`](./24-gin-gist-indexes.md) — GIN internals, `gin_pending_list_limit`, `fastupdate`
- [`64-system-catalogs.md`](./64-system-catalogs.md) — `pg_ts_config`, `pg_ts_dict`, `pg_ts_parser`, `pg_ts_template` catalogs
- [`65-collations-encoding.md`](./65-collations-encoding.md) — `lc_ctype`'s role in parser letter detection
- [`93-pg-trgm.md`](./93-pg-trgm.md) — substring/fuzzy alternative to FTS
- [`94-pgvector.md`](./94-pgvector.md) — semantic-embedding alternative to FTS
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — pick FTS vs pg_trgm vs pgvector decision walkthrough


## Sources

[^intro]: "Full Text Search — Introduction," PostgreSQL 16 docs. Verbatim quotes for: document definition, `tsvector` normalization rule, `@@` operator, tsquery booleans, phrase search. https://www.postgresql.org/docs/16/textsearch-intro.html

[^datatype]: "Text Search Types," PostgreSQL 16 docs. Verbatim quotes for: tsvector internal structure ("a sorted list of distinct lexemes"), sorting/dedup ("done automatically during input"), position cap ("Position values can range from 1 to 16383; larger numbers are silently set to 16383"), no-normalization rule ("tsvector type itself does not perform any word normalization"), weights, tsquery operators and precedence ("`!` (NOT) binds most tightly, `<->` (FOLLOWED BY) next most tightly, then `&` (AND), with `|` (OR) binding the least tightly"), prefix matching, weight-restriction syntax. https://www.postgresql.org/docs/16/datatype-textsearch.html

[^tables]: "Tables and Indexes," PostgreSQL 16 docs. Verbatim quotes for: generated column recipe, expression index alternative, generated-column vs expression-index trade-off ("One advantage of the separate-column approach over an expression index ..."). https://www.postgresql.org/docs/16/textsearch-tables.html

[^controls]: "Controlling Text Search," PostgreSQL 16 docs. Verbatim quotes for: to_tsvector / to_tsquery / plainto_tsquery / phraseto_tsquery / setweight signatures and behaviors; ranking expense ("Ranking can be expensive since it requires consulting the `tsvector` of each matching document, which can be I/O bound and therefore slow. Unfortunately, it is almost impossible to avoid since practical queries often result in large numbers of matches."); ts_rank and ts_rank_cd signatures + cover-density citation; normalization bitmask (every value); ts_headline signature and option defaults; ts_headline XSS Warning verbatim. https://www.postgresql.org/docs/16/textsearch-controls.html

[^features]: "Additional Features," PostgreSQL 16 docs. Verbatim quotes for: `||` concatenation rule, setweight ("Weight labels apply to positions, not lexemes. If the input vector has been stripped of positions then `setweight` does nothing."), length, strip ("the `<->` (FOLLOWED BY) `tsquery` operator will never match stripped input, since it cannot determine the distance between lexeme occurrences"), && / || / !! tsquery operators, tsquery_phrase, numnode, querytree, ts_rewrite (both forms), trigger-functions-obsoleted note ("The method described in this section has been obsoleted by the use of stored generated columns"), ts_stat. https://www.postgresql.org/docs/16/textsearch-features.html

[^functions]: "Text Search Functions and Operators," PostgreSQL 16 docs. Verbatim quotes for: every operator description in Table 9.42; vector construction signatures (to_tsvector for text/json/jsonb, array_to_tsvector, json_to_tsvector); query construction including websearch_to_tsquery ("Quoted word sequences are converted to phrase tests. The word 'or' is understood as producing an OR operator, and a dash produces a NOT operator; other punctuation is ignored. This approximates the behavior of some common web search tools."); ts_delete, ts_filter, get_current_ts_config, ts_lexize. https://www.postgresql.org/docs/16/functions-textsearch.html

[^indexes]: "Preferred Index Types for Text Search," PostgreSQL 16 docs. Verbatim quotes for: "GIN indexes are the preferred text search index type."; GIN/GiST syntax; siglen default and max; lossiness rule ("A GiST index is lossy ... it is necessary to check the actual table row to eliminate such false matches. ... Lossiness causes performance degradation due to unnecessary fetches of table records that turn out to be false matches."); maintenance_work_mem note ("GIN index build time can often be improved by increasing maintenance_work_mem, while GiST index build time is not sensitive to that parameter"); multi-word search mechanism. https://www.postgresql.org/docs/16/textsearch-indexes.html

[^gin-ops]: "Built-in GIN Operator Classes," PostgreSQL 16 docs. tsvector_ops supports `@@` and the deprecated `@@@`. https://www.postgresql.org/docs/16/gin-builtin-opclasses.html

[^limits]: "Limitations," PostgreSQL 16 docs. Verbatim limits: "The length of each lexeme must be less than 2 kilobytes"; "The length of a `tsvector` (lexemes + positions) must be less than 1 megabyte"; "The number of lexemes must be less than 2^64"; "Position values in `tsvector` must be greater than 0 and no more than 16,383"; "The match distance in a `<N>` (FOLLOWED BY) `tsquery` operator cannot be more than 16,384"; "No more than 256 positions per lexeme"; "The number of nodes (lexemes + operators) in a `tsquery` must be less than 32,768". https://www.postgresql.org/docs/16/textsearch-limitations.html

[^config]: "Configurations," PostgreSQL 16 docs. Verbatim quote about what a text search configuration is and about `default_text_search_config`. https://www.postgresql.org/docs/16/textsearch-configuration.html

[^createconfig]: "CREATE TEXT SEARCH CONFIGURATION," PostgreSQL 16 docs. Full synopsis. https://www.postgresql.org/docs/16/sql-createtsconfig.html

[^createdict]: "CREATE TEXT SEARCH DICTIONARY," PostgreSQL 16 docs. Full synopsis and Snowball example. https://www.postgresql.org/docs/16/sql-createtsdictionary.html

[^dicts]: "Dictionaries," PostgreSQL 16 docs. Verbatim quotes for: simple template ("operates by converting the input token to lower case and checking it against a file of stop words" + "only useful to place a `simple` dictionary at the end of a list of dictionaries"), synonym template, thesaurus template (including "Thesauruses are used during indexing so any change in the thesaurus dictionary's parameters _requires_ reindexing"), ispell template ("should be followed by another broader dictionary"), snowball template ("A Snowball dictionary recognizes everything, whether or not it is able to simplify the word, so it should be placed at the end of the dictionary list"), the general ordering rule ("The general rule for configuring a list of dictionaries is to place first the most narrow, most specific dictionary, then the more general dictionaries, finishing with a very general dictionary"), UTF-8 requirement ("These files _must_ be stored in UTF-8 encoding"), session caching rule ("Normally, a database session will read a dictionary configuration file only once"). https://www.postgresql.org/docs/16/textsearch-dictionaries.html

[^unaccent]: "unaccent," PostgreSQL 16 docs. Verbatim quote: "`unaccent` is a text search dictionary that removes accents (diacritic signs) from lexemes. It's a filtering dictionary, which means its output is always passed to the next dictionary (if any), unlike the normal behavior of dictionaries." https://www.postgresql.org/docs/16/unaccent.html

[^parsers]: "Parsers," PostgreSQL 16 docs. Verbatim quotes for: parser role ("Note that a parser does not modify the text at all — it simply identifies plausible word boundaries"), locale dependency ("The parser's notion of a 'letter' is determined by the database's locale setting, specifically `lc_ctype`"), overlapping tokens, full 23-token-type table. https://www.postgresql.org/docs/16/textsearch-parsers.html

[^debug]: "Testing and Debugging Text Search," PostgreSQL 16 docs. ts_debug, ts_parse, ts_token_type, ts_lexize signatures and rules including "ts_lexize function expects a single token, not text". https://www.postgresql.org/docs/16/textsearch-debugging.html

[^psql]: "psql Support," PostgreSQL 16 docs. \dF / \dFd / \dFp / \dFt verbatim descriptions. https://www.postgresql.org/docs/16/textsearch-psql.html

[^pg14-discard]: PostgreSQL 14 release notes. Verbatim: "Fix `to_tsquery()` and `websearch_to_tsquery()` to properly parse query text containing discarded tokens (Alexander Korotkov). Certain discarded tokens, like underscore, caused the output of these functions to produce incorrect tsquery output, e.g., both `websearch_to_tsquery('"pg_class pg"')` and `to_tsquery('pg_class <-> pg')` used to output `('pg' & 'class') <-> 'pg'`, but now both output `'pg' <-> 'class' <-> 'pg'`." Also: "Fix `websearch_to_tsquery()` to properly parse multiple adjacent discarded tokens in quotes ... `websearch_to_tsquery('"aaa: bbb"')` used to output `'aaa' <2> 'bbb'`, but now outputs `'aaa' <-> 'bbb'`." https://www.postgresql.org/docs/release/14.0/

[^pg14-langs]: PostgreSQL 14 release notes. Verbatim: "Add support for the stemming of languages Armenian, Basque, Catalan, Hindi, Serbian, and Yiddish (Peter Eisentraut)." https://www.postgresql.org/docs/release/14.0/

[^pg14-readline]: PostgreSQL 14 release notes. Verbatim: "Allow tsearch data files to have unlimited line lengths (Tom Lane). The previous limit was 4K bytes. Also remove function `t_readline()`." https://www.postgresql.org/docs/release/14.0/

[^pg15-array]: PostgreSQL 15 release notes. Verbatim: "Generate an error if `array_to_tsvector()` is passed an empty-string array element (Jean-Christophe Arnu). This is prohibited because lexemes should never be empty. Users of previous Postgres releases should verify that no empty lexemes are stored because they can lead to dump/restore failures and inconsistent results." Also: "Ignore NULL array elements in `ts_delete()` and `setweight()` functions with array arguments (Jean-Christophe Arnu)." https://www.postgresql.org/docs/release/15.0/

[^pg16-headline]: PostgreSQL 16 release notes. Verbatim: "Improve the handling of full text highlighting function `ts_headline()` for `OR` and `NOT` expressions (Tom Lane)." https://www.postgresql.org/docs/release/16.0/

[^pg17-unaccent]: PostgreSQL 17 release notes. Verbatim: "Allow unaccent character translation rules to contain whitespace and quotes (Michael Paquier). The syntax for the `unaccent.rules` file has changed." https://www.postgresql.org/docs/release/17.0/

[^pg18-cfg]: PostgreSQL 18 release notes. Verbatim: "Change full text search to use the default collation provider of the cluster to read configuration files and dictionaries, rather than always using libc (Peter Eisentraut). Clusters that default to non-libc collation providers (e.g., ICU, builtin) that behave differently than libc for characters processed by LC_CTYPE could observe changes in behavior of some full-text search functions, as well as the pg_trgm extension. When upgrading such clusters using pg_upgrade, it is recommended to reindex all indexes related to full-text search and pg_trgm after the upgrade." https://www.postgresql.org/docs/release/18.0/

[^pg18-est]: PostgreSQL 18 release notes. Verbatim: "Add full text search stemming for Estonian (Tom Lane)." https://www.postgresql.org/docs/release/18.0/

[^pg18-paral]: PostgreSQL 18 release notes — parallel GIN build. https://www.postgresql.org/docs/release/18.0/

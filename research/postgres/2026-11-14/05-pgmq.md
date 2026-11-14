# pgmq research

Research date: 2026-11-14. Method: read the GitHub repo through `gh api` (repo `pgmq/pgmq`, branch `main`, which is 1 commit ahead of tag `v1.13.1`; `pgmq-extension/sql/pgmq.sql` is byte-identical at `main` and `v1.13.1`, checked with `diff`). All SQL quoted below was read from that file. No live database was run (see Not verified).

Base URLs used in the Source column:

- `R` = `https://github.com/pgmq/pgmq/blob/main/`
- SQL = `R` + `pgmq-extension/sql/pgmq.sql` (line numbers refer to this file at v1.13.1)
- DOC-F = `R` + `docs/api/sql/functions.md`
- DOC-T = `R` + `docs/api/sql/types.md`
- DOC-FIFO = `R` + `docs/fifo-queues.md`
- DOC-PART = `R` + `docs/partitioned-queues.md`
- DOC-TOPIC = `R` + `docs/topics.md`

## Identity

```yaml
name: pgmq
description: "A lightweight message queue. Like AWS SQS and RSMQ but on Postgres."
repo: https://github.com/pgmq/pgmq          # confirmed; org "pgmq"; created 2023-07-24
previous_repo: https://github.com/tembo-io/pgmq   # v1.0-v1.5.1 release notes link here; github.com/tembo-io/pgmq now HTTP 200 (redirect) -> pgmq/pgmq
docs_site: https://pgmq.github.io/pgmq/     # HTTP 200; mkdocs-material, versioned with mike
maintainer: "Adam Hendel <adam@hendel.dev>" # pgmq-extension/META.json.in "maintainer"; .github/CODEOWNERS: @ChuckHend @theory @v0idpwn (pgmq-rs: @ChuckHend @spencewenski)
originally: Tembo (README "Who uses pgmq?" lists Tembo first; releases up to v1.5.1 were under tembo-io; moved to the pgmq org in v1.6.0, 2025-07-13)
license: PostgreSQL License (SPDX PostgreSQL)   # gh repo view; META.json.in "license": "postgresql"
latest_version: 1.13.1                      # pgmq.control default_version = '1.13.1'; PGXN shows 1.13.1
released: 2026-10-20                        # GitHub release v1.13.1 published 2026-10-20T00:03:59Z
previous_releases: [1.13.0 (2026-09-07), 1.12.0 (2026-07-14), 1.11.1 (2026-04-19), 1.11.0 (2026-02-19)]
pg_versions:
  readme_text: "Supported on Postgres 14-18."          # README.md line 24
  readme_badge: "13 | 14 | 15 | 16 | 17 | 18"          # README.md line 5 (disagrees with the text)
  ci_matrix: "13-18 x pg_partman 4.7.3 and 5.1.0 (13 excluded for 5.1.0)"   # .github/workflows/extension_ci.yml
  docker_images: "ghcr.io/pgmq/pg{14,15,16,17,18}-pgmq"  # .github/workflows/release.yml matrix
  pg19: "not listed anywhere upstream (README, CI matrix, image matrix)"
  stale_metadata: "META.json.in prereqs.runtime.requires PostgreSQL 11.0.0, recommends pg_partman 4.5.1 (stale; do not cite)"
extension_control: |
  default_version = '1.13.1'
  module_pathname = '$libdir/pgmq'
  schema = 'pgmq'
  relocatable = false
  superuser = false
shared_preload_libraries_needed: false
  # Pure PL/pgSQL since v1.2.0 (most functions) / v1.3.2 ("The extension doesn't have more shared objects and is pure PL/pgSQL").
  # No background worker: README "Lightweight - No background worker or external dependencies, just Postgres SQL objects".
  # Only partitioned queues need pg_partman; pg_partman's own bgw (pg_partman_bgw in shared_preload_libraries) is optional and is pg_partman's, not pgmq's.
install:
  extension:
    - "PGXN: pgxn install pgmq (needs pgxn client + pg_config on PATH, run on the DB host)"
    - "From source: git clone https://github.com/pgmq/pgmq.git; cd pgmq/pgmq-extension; make && make install"
    - "then: CREATE EXTENSION pgmq;   (creates schema pgmq automatically; relocatable = false)"
    - "superuser = false in control file: per PG docs, only the privileges needed by the install script are required (no superuser requirement imposed by the control file)"
  docker:
    - "docker run -d --name pgmq-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 ghcr.io/pgmq/pg18-pgmq:v1.10.0   # README pins v1.10.0 (stale); release workflow also pushes :latest and :v<TAG_VER>"
    - "images are Postgres with pgmq pre-installed; run CREATE EXTENSION pgmq; after connecting (README)"
  sql_only_no_create_extension:
    - "psql -f pgmq-extension/sql/pgmq.sql <connstr>   # creates schema pgmq and all objects; INSTALLATION.md: 'not versioned and only works for a fresh installation'"
    - "versioned SQL-only via Rust client: cargo install pgmq --features cli --bin pgmq-cli; pgmq-cli install -d <connstr> install-from-embedded | install-from-github -v 1.9.0"
    - "uninstall SQL-only: DROP SCHEMA pgmq CASCADE;  uninstall extension: DROP EXTENSION pgmq; (drops all queues and data)"
  upgrade:
    - "extension: build/install new files then ALTER EXTENSION pgmq UPDATE;  (UPDATING.md)"
    - "versions before 0.14.3 unsupported (re-install); pre-1.0.0 -> post-1.0.0 requires stopping at 1.0.0 first"
    - "plain-SQL install has no supported upgrade path (INSTALLATION.md Considerations table)"
  managed_services: "INSTALLATION.md: extension install is 'limited' on managed cloud; SQL-only 'compatible with most managed services'. Upstream does not name specific providers except that Supabase and Tembo are listed as users."
official_clients: [Rust (in-repo pgmq-rs, crate `pgmq`, crates.io latest stable 0.33.7, 0.34.0-alpha.7 on main), Python (https://github.com/pgmq/pgmq-py, PyPI `pgmq` 1.1.4, Apache-2.0)]
```

Sources for this block: `R`README.md, `R`INSTALLATION.md, `R`UPDATING.md, `R`pgmq-extension/pgmq.control, `R`pgmq-extension/META.json.in, `R`.github/workflows/extension_ci.yml, `R`.github/workflows/release.yml, `R`.github/CODEOWNERS, `R`SECURITY.md (supported: >= 1.3.2), https://pgxn.org/dist/pgmq/, https://www.postgresql.org/docs/current/extend-extensions.html, https://crates.io/api/v1/crates/pgmq, https://pypi.org/pypi/pgmq/json.

## SQL API

All functions live in schema `pgmq`. Every function is `SECURITY INVOKER` with `SET search_path = pg_catalog, pg_temp` (SQL lines 139-149). `qty` and `vt` on `read` have no defaults. The message record is `pgmq.message_record` (see below). Queue names are folded to lower case in table names by `format_table_name` (`lower(prefix || '_' || queue_name)`, SQL 362-371).

### Message and result types

| Type | Columns, in order | Source |
|---|---|---|
| `pgmq.message_record` | `msg_id bigint, read_ct integer, enqueued_at timestamptz, last_read_at timestamptz, vt timestamptz, message jsonb, headers jsonb` | SQL 116-124; DOC-T |
| `pgmq.queue_record` | `queue_name varchar, is_partitioned boolean, is_unlogged boolean, created_at timestamptz` | SQL 128-133 |
| `pgmq.metrics_result` | `queue_name text, queue_length bigint, newest_msg_age_sec int, oldest_msg_age_sec int, total_messages bigint, scrape_time timestamptz, queue_visible_length bigint, default_partition_length bigint` | SQL 896-905 |

SQL comment on field order (SQL 114-115): "Changing the order of fields in this type is a breaking change -- our Rust Diesel client implementation expects a specific order of fields." `last_read_at` was inserted as the 4th column in v1.10.0, so positional consumers of `read()` output broke at that release.

### Queue lifecycle

| Function | Full signature | Returns | Defaults / notes | Source |
|---|---|---|---|---|
| `create` | `pgmq.create(queue_name text)` | `void` | Calls `create_non_partitioned`. Idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING` on `pgmq.meta`). Name max 47 chars. | SQL 1613-1618; DOC-F "create" |
| `create_non_partitioned` | `pgmq.create_non_partitioned(queue_name text)` | `void` | Same as `create()`. | SQL 1234-1305 |
| `create_unlogged` | `pgmq.create_unlogged(queue_name text)` | `void` | Queue table is `UNLOGGED`; the archive table is still a normal logged table (SQL 1319 vs 1334). | SQL 1307-1377 |
| `create_partitioned` | `pgmq.create_partitioned(queue_name text, partition_interval text DEFAULT '10000', retention_interval text DEFAULT '100000', premake integer DEFAULT 4)` | `void` | Requires pg_partman (`pgmq._ensure_pg_partman_installed()` raises `pg_partman is required for partitioned queues`). `premake < 1` raises. Integer-like `partition_interval` partitions by `msg_id`; anything else (e.g. `'1 day'`) partitions the queue by `enqueued_at` and the archive by `archived_at`. `premake` was added in v1.13.0; the 3-arg form was dropped. | SQL 1596-1611, 1427-1594; DOC-PART |
| `convert_archive_partitioned` | `pgmq.convert_archive_partitioned(table_name text, partition_interval text DEFAULT '10000', retention_interval text DEFAULT '100000', leading_partition int DEFAULT 10)` | `void` | Renames `a_<q>` to `a_<q>_old`, creates a partitioned `a_<q>`; data is not migrated. `table_name` is the queue name. `leading_partition` is accepted but is not referenced anywhere in `_convert_archive_partitioned` (no `p_premake` passed to `create_parent`). | SQL 1660-1773 |
| `drop_queue` | `pgmq.drop_queue(queue_name text)` | `boolean` | Drops `q_<name>` and `a_<name>`, deletes the `pgmq.meta` row (cascades to `notify_insert_throttle` and `topic_bindings`), and for partitioned queues deletes the `part_config` rows. Returns `false` with a NOTICE if the queue does not exist. Takes the per-queue advisory lock. | SQL 1133-1199 |
| `drop_queue` (deprecated) | `pgmq.drop_queue(queue_name text, partitioned boolean)` | `boolean` | Emits a WARNING, calls the 1-arg form; removal planned in v2.0. | SQL 1117-1131 |
| `detach_archive` (deprecated) | `pgmq.detach_archive(queue_name text)` | `void` | No-op with a WARNING: "deprecated and is a no-op. It will be removed in PGMQ v2.0. Archive tables are no longer member objects." | SQL 1008-1015 |
| `purge_queue` | `pgmq.purge_queue(queue_name text)` | `bigint` | `SELECT count(*)` then `TRUNCATE TABLE pgmq.q_<name>`. Touches only the queue table, not the archive. | SQL 990-1005 |
| `list_queues` | `pgmq.list_queues()` | `SETOF pgmq.queue_record` | `SELECT * FROM pgmq.meta`. | SQL 982-987 |
| `validate_queue_name` | `pgmq.validate_queue_name(queue_name text)` | `void` | Raises when `length > 47`. Comment: complete identifier must be <= 63 (`template_pgmq_q_` 16 + 47). | SQL 1201-1212 |
| `acquire_queue_lock` | `pgmq.acquire_queue_lock(queue_name text)` | `void` | `pg_advisory_xact_lock(hashtext('pgmq.queue_' \|\| queue_name))`; serialises create/drop of the same queue. | SQL 154-159 |
| `format_table_name` | `pgmq.format_table_name(queue_name text, prefix text)` | `text` | Rejects names matching `\$\|;\|--\|'` ("queue name contains invalid characters"); returns `lower(prefix \|\| '_' \|\| queue_name)`. | SQL 362-371 |

### Sending

| Function | Full signature | Returns | Defaults / notes | Source |
|---|---|---|---|---|
| `send` | 6 overloads: `(queue_name text, msg jsonb)`, `(..., headers jsonb)`, `(..., delay integer)`, `(..., delay timestamptz)`, `(..., headers jsonb, delay integer)`, `(..., headers jsonb, delay timestamptz)` | `SETOF bigint` (msg_id) | No-arg defaults: `headers` NULL, `delay` = now. Integer `delay` = seconds: `vt = clock_timestamp() + make_interval(secs => delay)`. Timestamp `delay` is the `vt` itself. Use `SELECT * FROM pgmq.send(...)` or `SELECT pgmq.send(...)`. Release 1.12.0 notes "Update pgmq.send examples to avoid 'function ... is not unique' error": untyped literal args can be ambiguous between overloads; pass named args or typed values. | SQL 725-790; DOC-F "send" |
| `send_batch` | 6 overloads mirroring `send` with `msgs jsonb[]` and `headers jsonb[]` | `SETOF bigint` | Raises `msgs cannot be NULL or empty`. If `headers` is not NULL its length must equal `msgs` length (empty `ARRAY[]::jsonb[]` fails for non-empty `msgs`). Implemented as one `INSERT ... SELECT $2, unnest($1), unnest(coalesce($3, ARRAY[]::jsonb[]))`. | SQL 793-891; DOC-F "send_batch" |
| `send_topic` | `(routing_key text, msg jsonb)`, `(routing_key text, msg jsonb, delay integer)`, `(routing_key text, msg jsonb, headers jsonb, delay integer)` | `integer` (queues delivered to) | Delay is integer seconds only (no timestamptz form). Raises on NULL `msg` or negative delay. | SQL 2098-2157; DOC-TOPIC |
| `send_batch_topic` | 6 overloads: `(routing_key text, msgs jsonb[] [, headers jsonb[]] [, delay integer \| timestamptz])` | `TABLE(queue_name text, msg_id bigint)` | One row per message per matching queue. | SQL 2197-2308 |
| `bind_topic` | `pgmq.bind_topic(pattern text, queue_name text)` | `void` | Idempotent. Queue must exist in `pgmq.meta`. | SQL 2020-2040 |
| `unbind_topic` | `pgmq.unbind_topic(pattern text, queue_name text)` | `boolean` | `true` if a binding was removed. | SQL 2042-2072 |
| `test_routing` | `pgmq.test_routing(routing_key text)` | `TABLE(pattern text, queue_name text, compiled_regex text)` | Dry run. | SQL 2074-2096 |
| `list_topic_bindings` | `pgmq.list_topic_bindings()` and `pgmq.list_topic_bindings(queue_name text)` | `TABLE(pattern, queue_name, bound_at, compiled_regex)` | Ordered by `bound_at DESC`. | SQL 2159-2194 |
| `validate_routing_key` / `validate_topic_pattern` | `(routing_key text)` / `(pattern text)` | `boolean` | Routing key: `^[a-zA-Z0-9._-]+$`, <= 255 chars, no leading/trailing/double dots. Pattern also allows `*` and `#`, rejects `**`, `##`, `*#`, `#*`. | SQL 1905-2018 |

### Reading

| Function | Full signature | Returns | Defaults / notes | Source |
|---|---|---|---|---|
| `read` | `pgmq.read(queue_name text, vt integer, qty integer, conditional jsonb DEFAULT '{}')` | `SETOF pgmq.message_record` | `vt` seconds. `conditional` filters with `message @> conditional`; docs mark it experimental ("subject to change"). Increments `read_ct`, sets `last_read_at` and `vt`. | SQL 375-413; DOC-F "read" |
| `read_with_poll` | `pgmq.read_with_poll(queue_name text, vt integer, qty integer, max_poll_seconds integer DEFAULT 5, poll_interval_ms integer DEFAULT 100, conditional jsonb DEFAULT '{}')` | `SETOF pgmq.message_record` | Loops the same query with `pg_sleep(poll_interval_ms/1000)` until rows are returned or `max_poll_seconds` elapses. This is a server-side polling loop, not LISTEN. | SQL 551-610 |
| `pop` | `pgmq.pop(queue_name text, qty integer DEFAULT 1)` | `SETOF pgmq.message_record` | Read-and-delete in one statement. Docs: pop "results in at-most-once delivery semantics". `qty` added in v1.7.0. | SQL 1018-1044; DOC-F "pop" |
| `read_grouped` | `pgmq.read_grouped(queue_name text, vt integer, qty integer)` | `SETOF pgmq.message_record` | SQS-FIFO style: fills the batch from the oldest eligible group first; group key = `headers->>'x-pgmq-group'`, missing = `'_default_fifo_group'`. | SQL 418-513 |
| `read_grouped_with_poll` | `(queue_name text, vt integer, qty integer, max_poll_seconds integer DEFAULT 5, poll_interval_ms integer DEFAULT 100)` | same | Poll wrapper. | SQL 517-547 |
| `read_grouped_rr` | `pgmq.read_grouped_rr(queue_name text, vt integer, qty integer)` | same | Round-robin layered interleaving across groups. Uses `pg_try_advisory_xact_lock(hashtextextended(group_key, 0))` per group. | SQL 163-244 |
| `read_grouped_rr_with_poll` | same poll params | same | Poll wrapper. | SQL 248-278 |
| `read_grouped_head` | `pgmq.read_grouped_head(queue_name text, vt integer, qty integer)` | same | At most one message per group (the head), up to `qty` groups. Added v1.11.1. | SQL 282-325 |
| `read_grouped_head_with_poll` | same poll params | same | Added v1.12.0. | SQL 329-359 |
| `create_fifo_index` | `pgmq.create_fifo_index(queue_name text)` | `void` | `CREATE INDEX IF NOT EXISTS q_<name>_fifo_idx ON pgmq.q_<name> USING GIN (headers)`. NOT created by `create()`. | SQL 1622-1645 |
| `create_fifo_indexes_all` | `pgmq.create_fifo_indexes_all()` | `void` | Loops `pgmq.meta`. | SQL 1649-1658 |

### Ack, delete, visibility

| Function | Full signature | Returns | Defaults / notes | Source |
|---|---|---|---|---|
| `archive` (single) | `pgmq.archive(queue_name text, msg_id bigint)` | `boolean` | `DELETE ... RETURNING` into `INSERT INTO a_<q>` in one statement; `true` if the row existed. | SQL 615-643 |
| `archive` (batch) | `pgmq.archive(queue_name text, msg_ids bigint[])` | `SETOF bigint` | Returns ids actually archived; missing ids are silently omitted. | SQL 648-674 |
| `delete` (single) | `pgmq.delete(queue_name text, msg_id bigint)` | `boolean` | | SQL 678-699 |
| `delete` (batch) | `pgmq.delete(queue_name text, msg_ids bigint[])` | `SETOF bigint` | | SQL 703-722 |
| `set_vt` (single) | `pgmq.set_vt(queue_name text, msg_id bigint, vt integer)` and `pgmq.set_vt(queue_name text, msg_id bigint, vt timestamptz)` | `SETOF pgmq.message_record` | Integer = seconds from now (`clock_timestamp()`). Timestamp form added v1.10.0 (breaking for implicit integer casts). Returns an empty set if the id does not exist. | SQL 1047-1071 |
| `set_vt` (batch) | `pgmq.set_vt(queue_name text, msg_ids bigint[], vt integer)` and `(..., vt timestamptz)` | `SETOF pgmq.message_record` | Added v1.8.0. | SQL 1074-1105 |

### Monitoring and notifications

| Function | Full signature | Returns | Defaults / notes | Source |
|---|---|---|---|---|
| `metrics` | `pgmq.metrics(queue_name text)` | `pgmq.metrics_result` | `queue_length` = `count(*)` of the queue table; `queue_visible_length` = rows with `vt <= now()`; ages from `enqueued_at`; `total_messages` = last value of the `msg_id` sequence (0 if never called); `default_partition_length` = planner estimate (`reltuples`) of the `_default` partitions of queue + archive, NULL for non-partitioned queues. | SQL 908-965; DOC-F "metrics" |
| `metrics_all` | `pgmq.metrics_all()` | `SETOF pgmq.metrics_result` | Loops `pgmq.meta` calling `metrics()`. | SQL 968-979 |
| `enable_notify_insert` | `pgmq.enable_notify_insert(queue_name text, throttle_interval_ms integer DEFAULT 250)` | `void` | Creates a deferrable constraint trigger `trigger_notify_queue_insert_listeners` (AFTER INSERT, FOR EACH ROW) calling `pgmq.notify_queue_listeners(<queue_name>)`; inserts into `pgmq.notify_insert_throttle`. Raises if queue missing or interval negative. Channel: `pgmq.q_<queue_name>.INSERT`; payload NULL. | SQL 1808-1843; DOC-F |
| `disable_notify_insert` | `pgmq.disable_notify_insert(queue_name text)` | `void` | Drops the trigger and the throttle row. | SQL 1845-1860 |
| `update_notify_insert` | `pgmq.update_notify_insert(queue_name text, throttle_interval_ms integer)` | `void` | Requires notify already enabled; resets `last_notified_at` to epoch. | SQL 1879-1903 |
| `list_notify_insert_throttles` | `pgmq.list_notify_insert_throttles()` | `TABLE(queue_name text, throttle_interval_ms integer, last_notified_at timestamptz)` | | SQL 1862-1877 |
| `notify_queue_listeners` | trigger function | `trigger` | Throttled `UPDATE pgmq.notify_insert_throttle ... WHERE throttle_interval_ms = 0 OR clock_timestamp() - last_notified_at >= interval`; if a row updated, `PG_NOTIFY('pgmq.q_' \|\| v_queue_name \|\| '.' \|\| TG_OP, NULL)`. | SQL 1775-1806 |

### Internal helpers (not for callers)

`_validate_batch_params`, `_send_batch`, `_create_fifo_index_if_not_exists`, `_create_partitioned`, `_convert_archive_partitioned`, `_get_partition_col`, `_get_pg_partman_schema`, `_get_pg_partman_major_version`, `_ensure_pg_partman_installed`, `_extension_exists`, `_belongs_to_pgmq` (SQL lines 793-833, 1107-1115, 1214-1232, 1379-1425, 1427-1594, 1620-1636).

## Storage model

Schema `pgmq` (control file `schema = 'pgmq'`, `relocatable = false`).

Per-queue objects (names after `lower()`):

| Object | Name | Definition (non-partitioned) | Source |
|---|---|---|---|
| Queue table | `pgmq.q_<name>` | `msg_id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY, read_ct INT DEFAULT 0 NOT NULL, enqueued_at TIMESTAMPTZ DEFAULT now() NOT NULL, last_read_at TIMESTAMPTZ, vt TIMESTAMPTZ NOT NULL, message JSONB, headers JSONB` | SQL 1244-1257 |
| Archive table | `pgmq.a_<name>` | `msg_id BIGINT PRIMARY KEY, read_ct INT DEFAULT 0 NOT NULL, enqueued_at TIMESTAMPTZ DEFAULT now() NOT NULL, last_read_at TIMESTAMPTZ, archived_at TIMESTAMPTZ DEFAULT now() NOT NULL, vt TIMESTAMPTZ NOT NULL, message JSONB, headers JSONB` | SQL 1259-1273 |
| Queue index | `q_<name>_vt_idx` | `(vt ASC)` on the queue table | SQL 1275-1280 |
| Archive index | `archived_at_idx_<queue_name>` | `(archived_at)` on the archive table (uses the queue name as passed, not lowercased) | SQL 1282-1287 |
| Sequence | `pgmq.q_<name>_msg_id_seq` | identity sequence; `metrics().total_messages` reads it | SQL 946-947 |
| Optional GIN index | `q_<name>_fifo_idx` | `USING GIN (headers)`, created only by `create_fifo_index` | SQL 1629-1634 |

Differences by queue kind:

| Kind | Difference | Source |
|---|---|---|
| unlogged | queue table `CREATE UNLOGGED TABLE`; archive table stays logged; `pgmq.meta.is_unlogged = true` | SQL 1319, 1334, 1364 |
| partitioned | queue `PARTITION BY RANGE (msg_id \| enqueued_at)`; `msg_id` is `GENERATED BY DEFAULT AS IDENTITY` (since v1.13.0, so `partition_data_proc` can reinsert existing ids); index `q_<name>_part_idx` on the partition column; archive partitioned by `msg_id` or `archived_at`, no primary key; pg_partman `part_config` set to `retention_keep_table = false, retention_keep_index = true, automatic_maintenance = 'on'` | SQL 1451-1583 |

Shared tables in `pgmq`:

| Table | Purpose | Source |
|---|---|---|
| `pgmq.meta(queue_name varchar UNIQUE NOT NULL, is_partitioned boolean NOT NULL, is_unlogged boolean NOT NULL, created_at timestamptz DEFAULT now() NOT NULL)` | queue registry | SQL 40-45 |
| `pgmq.notify_insert_throttle(queue_name varchar UNIQUE NOT NULL REFERENCES pgmq.meta ON DELETE CASCADE, throttle_interval_ms integer NOT NULL DEFAULT 0, last_notified_at timestamptz NOT NULL DEFAULT to_timestamp(0))` | UNLOGGED; NOTIFY throttling state | SQL 60-67 |
| `pgmq.topic_bindings(pattern text, queue_name text REFERENCES pgmq.meta ON DELETE CASCADE, bound_at timestamptz, compiled_regex text GENERATED ALWAYS ... STORED, UNIQUE (pattern, queue_name))` | topic routing; `*` -> `[^.]+`, `#` -> `.*`, anchored `^...$` | SQL 73-98 |

When installed as an extension, `pgmq.meta`, `pgmq.notify_insert_throttle` and `pgmq.topic_bindings` are registered with `pg_extension_config_dump` so `pg_dump` includes their rows (SQL 100-110). Queue and archive tables are not extension members (deprecation text of `detach_archive`).

`pg_monitor` grants (changed in v1.13.1): `USAGE` on schema `pgmq`, `SELECT` on `pgmq.meta`, and per queue column-level `SELECT (vt, enqueued_at)` on the queue table plus `SELECT` on the `msg_id` sequence; no access to payload columns or archive tables (SQL 47-57, 1299-1302).

### The read query, verbatim (SQL 386-410)

```sql
WITH cte AS
(
    SELECT msg_id
    FROM pgmq.%I
    WHERE vt <= clock_timestamp() AND CASE
        WHEN %L != '{}'::jsonb THEN (message @> %2$L)::integer
        ELSE 1
    END = 1
    ORDER BY msg_id ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE pgmq.%I m
SET
    last_read_at = clock_timestamp(),
    vt = clock_timestamp() + %L,
    read_ct = read_ct + 1
FROM cte
WHERE m.msg_id = cte.msg_id
RETURNING m.msg_id, m.read_ct, m.enqueued_at, m.last_read_at, m.vt, m.message, m.headers;
```

`pop` (SQL 1027-1038): same `cte` (`WHERE vt <= clock_timestamp() ORDER BY msg_id ASC LIMIT $1 FOR UPDATE SKIP LOCKED`) followed by `DELETE from pgmq.%I WHERE msg_id IN (select msg_id from cte) RETURNING ...`.

`archive` (SQL 628-636): `WITH archived AS (DELETE FROM pgmq.%I WHERE msg_id = $1 RETURNING msg_id, vt, read_ct, enqueued_at, last_read_at, message, headers) INSERT INTO pgmq.%I (...) SELECT ... FROM archived RETURNING msg_id;`.

## Semantics & guarantees

- Delivery: README says "Guaranteed 'exactly once' delivery of messages to a consumer within a visibility timeout". Mechanism: `FOR UPDATE SKIP LOCKED` in the CTE locks the candidate rows, and the `UPDATE` moves `vt` forward in the same statement. Two concurrent `read()` calls therefore get disjoint rows. After `vt` expires with no `delete`/`archive`, the row is visible again and is redelivered with `read_ct` incremented. Across expirations this is at-least-once; pgmq stores no consumer identity.
- `pop()` deletes on read: DOC-F says it "results in at-most-once delivery semantics if the consuming application does not guarantee processing of the message".
- Set `vt` greater than expected processing time (README "Visibility Timeout (vt)"). Extend with `set_vt`; force immediate retry with `set_vt(queue, id, 0)` (DOC-FIFO "Manual Retry").
- Ordering: `read()` orders by `msg_id ASC` among visible rows. With concurrent consumers, `SKIP LOCKED` gives no strict ordering guarantee. Strict per-key ordering needs the FIFO readers and the `x-pgmq-group` header (DOC-FIFO).
- FIFO readers (`read_grouped`, `read_grouped_rr`, `read_grouped_head`) key on `headers->>'x-pgmq-group'`; no header = single `_default_fifo_group`. Upstream comparison table says pgmq FIFO has no message deduplication, no "exactly-once delivery" (vs SQS FIFO) and no throughput limits. Docs recommend `create_fifo_index` for FIFO-heavy queues.
- Transactions: send and read participate in the caller's transaction. Upstream isolation test `pgmq-extension/test/specs/transaction_tests.spec` runs `send` uncommitted in session 1 and `read` in session 2, and a `read` followed by `ROLLBACK`, then re-reads (spec only; expected output in `pgmq-extension/test/expected/transaction_tests.out` not read). `send_topic` docs: "All sends succeed or all fail (transactional)".
- Delay: `send(..., delay)` stores `vt` in the future; the message exists but is unreadable until `vt`. Timestamp delay stores that exact timestamp.
- Time source: `read`, `pop`, `set_vt` use `clock_timestamp()` (since v1.5.1, earlier `now()`), so `vt` is evaluated per statement, not per transaction.
- `archive` = delete from queue + insert into archive (permanent, same row data plus `archived_at`). `delete` = gone. `purge_queue` = truncate the queue table only.
- Message type: `message` and `headers` are `jsonb`; `message` may be NULL (test "reading null message", v1.5.0 PR 329).
- Topic matching quirk (source reading): `#` compiles to `.*` and is always placed after a literal `.`, so `logs.#` compiles to `^logs\..*$` and does not match bare `logs`; bare `#` compiles to `^.*$` and matches every key. The SQL comment in `validate_topic_pattern` says "one or more segments" while DOC-TOPIC says "zero or more"; DOC-TOPIC's own table lists `logs` as a non-match for `logs.#`.
- `read_grouped` doc/behavior mismatch: DOC-F says "Only the oldest unprocessed message from each FIFO group can be read" yet its example returns three messages from group `user123` in one call. The SQL (LATERAL ... `LIMIT $1` per group) returns several messages per group when no earlier message in that group is in flight. DOC-FIFO describes this as "fill from same group".

## Operations

### Bloat and VACUUM

Upstream docs, README and INSTALLATION do not discuss VACUUM, autovacuum tuning, bloat or fillfactor (searched `README.md`, `INSTALLATION.md`, `UPDATING.md`, `docs/`, `mkdocs.yml`; the only "vacuum" hits are two sentences in DOC-PART about autovacuum refreshing the `default_partition_length` estimate). What the SQL shows: queue tables are plain heap tables with no per-table storage parameters, and every `read` is an `UPDATE` (new row version each time `vt`/`read_ct`/`last_read_at` change), every ack is a `DELETE` or `DELETE`+`INSERT`. This is MVCC churn on `q_<name>` and its `(vt)` and PK indexes. Anything stronger than that (tuning advice) is not upstream content; use `28-vacuum-autovacuum.md` for the general mechanics and label it as derived.

### Partitioned queues and pg_partman (DOC-PART)

- Install pg_partman separately. pgmq finds its schema through `pg_extension` (`_get_pg_partman_schema()`), calls `create_parent(p_parent_table, p_control, p_interval, p_premake, p_type)` with `p_type = 'range'` for pg_partman major version 5, else `'native'`, then updates `part_config` (retention, `retention_keep_table = false`, `retention_keep_index = true`, `automatic_maintenance = 'on'`). CI tests pg_partman 4.7.3 and 5.1.0.
- `partition_interval`: integer string => partition by `msg_id`; duration => partition by `enqueued_at` (archive: `archived_at`). Defaults `'10000'`, retention `'100000'`, `premake` 4. `retention_interval` must be the same kind (numeric vs time) as `partition_interval`.
- Retention drops whole partitions. DOC-PART: "`retention_interval` does not apply to messages that have been deleted via `pgmq.delete()` or archived with `pgmq.archive()`."
- Maintenance config shipped in pgmq Docker images (DOC-PART):

```text
shared_preload_libraries = 'pg_partman_bgw' # requires restart of Postgres
pg_partman_bgw.interval = 60
pg_partman_bgw.role = 'postgres'
pg_partman_bgw.dbname = 'postgres'
```

- Runway and overrun (v1.13.0): roughly `partition_interval x premake` messages (or that much time) between maintenance runs; defaults give about 40,000 messages per minute at `pg_partman_bgw.interval = 60`. Crossing it does not fail `send()`; rows land in the pg_partman default partition and `run_maintenance` then fails for that queue and retention stops. Monitor `pgmq.metrics().default_partition_length`; DOC-PART: "Zero is the only healthy value."
- Recovery, verbatim from DOC-PART (run `partition_data_proc` outside a transaction block):

```sql
CALL partman.partition_data_proc('pgmq.q_my_queue');
SELECT partman.run_maintenance('pgmq.q_my_queue');
ANALYZE pgmq.q_my_queue_default;
```

  Run the same three statements against `pgmq.a_my_queue` if the archive spilled.
- Caveat from DOC-PART: partitioned `msg_id` is `GENERATED BY DEFAULT`, so Postgres no longer rejects an explicit `msg_id` insert; write only through the pgmq API.

### LISTEN/NOTIFY integration (DOC-F)

- `pgmq.enable_notify_insert(queue, throttle_interval_ms DEFAULT 250)`; channel `pgmq.q_<queue_name>.INSERT`, case-preserved since v1.13.1 (the 1.13.1 fix: "insert notifications never fire for a queue name that is not all lowercase"). Because the identifier contains dots, quote it: upstream example is `LISTEN "pgmq.q_my_queue.INSERT";`.
- The payload is NULL; the notification is a doorbell, the consumer then calls `read`/`read_with_poll`.
- Throttle: at most one NOTIFY per `throttle_interval_ms` per queue; `0` disables throttling. Upstream guidance: notifications help sporadic or low-volume queues; busy queues can poll continuously.
- Source-reading observations, not upstream-documented: the trigger is `CREATE CONSTRAINT TRIGGER ... AFTER INSERT ... DEFERRABLE FOR EACH ROW`, and each inserted row runs an `UPDATE` on that queue's `pgmq.notify_insert_throttle` row, so concurrent inserters into a notify-enabled queue touch the same row. Unlogged `notify_insert_throttle` is truncated on crash recovery.
- Upstream has client-side tests for this (python tests under `pgmq-extension/client-tests/`); no server-side wait function exists.

### Monitoring

- `SELECT * FROM pgmq.metrics('q')` / `pgmq.metrics_all()`; `pg_monitor` members can run them without reading payloads (v1.13.1). Metrics `queue_length`, `queue_visible_length`, `oldest_msg_age_sec`, `total_messages`, `default_partition_length`. `list_queues()` / `pgmq.meta` for inventory; `pgmq.list_notify_insert_throttles()` and `pgmq.list_topic_bindings()` for the two config tables.

### Client libraries (official, per README "Client Libraries" section, which separates them from "Community")

| Client | Location | Notes |
|---|---|---|
| Rust | https://github.com/pgmq/pgmq/tree/main/pgmq-rs | crate `pgmq`; sqlx default; also rust-postgres and diesel `Queue` trait impls (v1.12.0-1.13.0); `pgmq-cli` for versioned SQL-only install; `PGMQueue` struct removed in 1.12.0 |
| Python | https://github.com/pgmq/pgmq-py (docs https://pgmq.github.io/pgmq-py/) | PyPI `pgmq` 1.1.4 (released 2026-09-20), Apache-2.0 |

Community clients are listed in README (e.g. Go `craigpastro/pgmq-go`, Ruby `mensfeld/pgmq-ruby`, Elixir, .NET `Npgmq`, Java, Kotlin, PHP, Scala, TypeScript variants); the task asked for official only, so they are not enumerated here. They are not maintained by the pgmq org.

### Other upstream operational notes

- Security (v1.13.1 release notes): "We recommend that everyone on v1.13.0 or earlier upgrade." Two fixes: pinned `search_path` and schema-qualified internal calls; `pg_monitor` no longer has `SELECT` on payload tables. The `1.13.0 -> 1.13.1` upgrade revokes old broad grants and logs a warning if a broad grant cannot be revoked.
- Earlier security patch: v1.4.1 "addresses SQL injection as described in tembo-io/pgmq issue 295"; v1.4.2 then forbade `$`, `'`, `;`, `--` in queue names.
- SECURITY.md: supported versions `>= 1.3.2`; report through GitHub private vulnerability reporting.

## Recipes found upstream

All verbatim from upstream; none were executed by me.

Create, send, read, ack (source: https://github.com/pgmq/pgmq/blob/main/README.md):

```sql
-- create the extension in the "pgmq" schema
CREATE EXTENSION pgmq;

-- creates the queue
SELECT pgmq.create('my_queue');

-- messages are sent as JSON
SELECT * from pgmq.send(
  queue_name  => 'my_queue',
  msg         => '{"foo": "bar1"}'
);

-- Optionally provide a delay
-- this message will be on the queue but unable to be consumed for 5 seconds
SELECT * from pgmq.send(
  queue_name => 'my_queue',
  msg        => '{"foo": "bar2"}',
  delay      => 5
);

SELECT * FROM pgmq.read(
  queue_name => 'my_queue',
  vt         => 30,
  qty        => 2
);

-- Read a message and immediately delete it from the queue. Returns an empty record if the queue is empty or all messages are invisible.
SELECT * FROM pgmq.pop('my_queue');

SELECT pgmq.archive(
  queue_name => 'my_queue',
  msg_id     => 2
);

SELECT pgmq.send_batch(
  queue_name => 'my_queue',
  msgs       => ARRAY['{"foo": "bar3"}','{"foo": "bar4"}','{"foo": "bar5"}']::jsonb[]
);

SELECT pgmq.archive(
  queue_name => 'my_queue',
  msg_ids    => ARRAY[3, 4, 5]
);

SELECT * FROM pgmq.a_my_queue;

SELECT pgmq.delete('my_queue', 6);

SELECT pgmq.drop_queue('my_queue');
```

Headers, timestamp delay, conditional read (source: https://github.com/pgmq/pgmq/blob/main/docs/api/sql/functions.md):

```sql
-- Send a message with headers
select * from pgmq.send('my_queue', '{"hello": "world"}', '{"trace_id": "abc123"}');

-- Message readable from tomorrow
select * from pgmq.send('my_queue', '{"hello": "world"}', CURRENT_TIMESTAMP + INTERVAL '1 day');

-- Send with headers for each message
select * from pgmq.send_batch('my_queue',
    ARRAY['{"hello": "world_0"}', '{"hello": "world_1"}']::jsonb[],
    ARRAY['{"trace_id": "abc"}', '{"trace_id": "def"}']::jsonb[]
);

-- Read a message from a queue with message filtering
select * from pgmq.read('my_queue', 10, 2, '{"hello": "world_1"}');

-- Set the visibility timeout of message 1 to 30 seconds from now.
select * from pgmq.set_vt('my_queue', 1, 30);

-- Delete messages, one that exists and one that does not
select * from pgmq.delete('my_queue', ARRAY[6, 999]);
```

Queue variants (source: same functions.md):

```sql
select pgmq.create_unlogged('my_unlogged');

select from pgmq.create_partitioned(
    'my_partitioned_queue',
    '100000',
    '10000000'
);

select from pgmq.convert_archive_partitioned('my_queue', '10000', '100000');

select * from pgmq.metrics('my_queue');
select * from pgmq.metrics_all();
select * from pgmq.list_queues();
```

Notifications (source: same functions.md):

```sql
-- Enable notifications with default 250ms throttling
select pgmq.enable_notify_insert('my_queue');

-- Enable notifications with custom 500ms throttling
select pgmq.enable_notify_insert('my_queue', 500);

-- In another session, listen for notifications:
-- LISTEN "pgmq.q_my_queue.INSERT";

SELECT pgmq.update_notify_insert('my_queue', 1000);
select pgmq.disable_notify_insert('my_queue');
```

FIFO groups (source: https://github.com/pgmq/pgmq/blob/main/docs/fifo-queues.md):

```sql
SELECT pgmq.send('my_queue', '{"order": 1}', headers=>'{"x-pgmq-group": "user123"}');
SELECT pgmq.send('my_queue', '{"order": 2}', headers=>'{"x-pgmq-group": "user123"}');
SELECT pgmq.send('my_queue', '{"order": 1}', headers=>'{"x-pgmq-group": "user456"}');

-- Fair distribution across groups (round-robin, layered)
SELECT * FROM pgmq.read_grouped_rr('my_queue', 30, 5);

-- Throughput-optimized, SQS-style batch filling
SELECT * FROM pgmq.read_grouped('my_queue', 30, 5);

-- One message per group, up to 5 groups
SELECT * FROM pgmq.read_grouped_head('my_queue', 30, 5);

SELECT pgmq.create_fifo_index('my_queue');
SELECT pgmq.create_fifo_indexes_all();

-- Set visibility timeout to 0 for immediate retry
SELECT pgmq.set_vt('my_queue', 123, 0);

-- After max retries, archive the problematic message
SELECT pgmq.archive('my_queue', 123);
```

Topic routing (source: https://github.com/pgmq/pgmq/blob/main/docs/topics.md):

```sql
SELECT pgmq.create('all_logs');
SELECT pgmq.create('error_logs');
SELECT pgmq.create('api_errors');

SELECT pgmq.bind_topic('logs.#', 'all_logs'); -- All logs
SELECT pgmq.bind_topic('logs.*.error', 'error_logs'); -- Error logs from any service
SELECT pgmq.bind_topic('logs.api.error', 'api_errors'); -- Only API errors

-- This message routes to: all_logs, error_logs, api_errors (3 queues)
SELECT pgmq.send_topic('logs.api.error', '{"message": "API failed"}');

SELECT *
FROM pgmq.test_routing('logs.api.error');

SELECT * FROM pgmq.list_topic_bindings();
SELECT pgmq.unbind_topic('orders.#', 'order_events');
```

Partition spill recovery (source: https://github.com/pgmq/pgmq/blob/main/docs/partitioned-queues.md):

```sql
CALL partman.partition_data_proc('pgmq.q_my_queue');
SELECT partman.run_maintenance('pgmq.q_my_queue');
ANALYZE pgmq.q_my_queue_default;
```

Plain-SQL install (source: https://github.com/pgmq/pgmq/blob/main/INSTALLATION.md):

```bash
git clone https://github.com/pgmq/pgmq.git
cd pgmq
psql -f pgmq-extension/sql/pgmq.sql postgres://postgres:postgres@localhost:5432/postgres
```

Upstream does not ship a worker-loop recipe in SQL (consumer loop logic lives in client libraries); the `read -> process -> archive|delete` sequence is the documented pattern (README "Visibility Timeout (vt)").

## Version history

Dates are GitHub release `published_at` (UTC date) from `gh api repos/pgmq/pgmq/releases`. "First SQL appearance" for 1.5+ features was confirmed by grepping the `pgmq--X--Y.sql` upgrade scripts.

| Version | Date | Changes relevant to the SQL API | Breaking / upgrade notes |
|---|---|---|---|
| 1.13.1 | 2026-10-20 | Search-path hardening (all functions pin `search_path`, schema-qualified internals); `pg_monitor` narrowed to `SELECT` on `pgmq.meta` + column-level `(vt, enqueued_at)` + sequence; fix: insert NOTIFY never fired for queue names that are not all lowercase | "We recommend that everyone on v1.13.0 or earlier upgrade." Upgrade logs a warning if old broad `pg_monitor` grants cannot be revoked |
| 1.13.0 | 2026-09-07 | `create_partitioned(..., premake integer DEFAULT 4)`; `metrics().default_partition_length`; partitioned `msg_id` becomes `GENERATED BY DEFAULT AS IDENTITY`; fix for partitioned queues silently overrunning premake. Rest of the release is Rust client work | 3-arg `create_partitioned` dropped and replaced (script: `DROP FUNCTION IF EXISTS pgmq.create_partitioned(TEXT, TEXT, TEXT)`); `metrics_result` gained a column |
| 1.12.0 | 2026-07-14 | `read_grouped_head_with_poll`. Rust: `PGMQueue` struct removed, sqlx 0.9, `Queue` trait | Rust client breaking changes |
| 1.11.1 | 2026-04-19 | `read_grouped_head` (one message per group, up to N groups); CI check that upgrade scripts match fresh install | none noted |
| 1.11.0 | 2026-02-19 | Topic routing (`bind_topic`, `unbind_topic`, `send_topic`, `send_batch_topic`, `test_routing`, `list_topic_bindings`, validators); `list_notify_insert_throttles`, `update_notify_insert`; faster `read_grouped` | none noted |
| 1.10.1 | 2026-02-16 | Fix migration SQL for `last_read_at` in queue creation functions | none |
| 1.10.0 | 2026-02-02 | `last_read_at` column on queue and archive tables and in `message_record` (4th position); `set_vt` accepts `timestamptz` | "Potentially breaking": `set_vt` vt now `timestamptz` or `integer` (implicit casts from other literals can fail); new column shifts positional result columns |
| 1.9.0 | 2026-01-18 | FIFO queues: `x-pgmq-group` header, `read_grouped`, `read_grouped_with_poll`, `read_grouped_rr`, `read_grouped_rr_with_poll`, `create_fifo_index`, `create_fifo_indexes_all`; versioned docs | none noted |
| 1.8.1 | 2025-12-29 | Time-based partitioning when converting an archive | none |
| 1.8.0 | 2025-11-30 | Notification throttling (`enable_notify_insert(queue, throttle_interval_ms)`); batch `set_vt(msg_ids bigint[], ...)`; PG18 support | none noted |
| 1.7.0 | 2025-09-11 | `pop(queue, qty)`; insert notifications (`enable_notify_insert`, `disable_notify_insert`) | none noted |
| 1.6.1 | 2025-07-18 | Migration patches (1.6.0 migration SQL, `pg_extension_config_dump` in main SQL) | none |
| 1.6.0 | 2025-07-13 | `drop_queue` returns false when queue missing; queue-name length check fix; race fix on `create` (advisory lock); extension data `pg_dump`-able; repo moved to `pgmq` org | none noted |
| 1.5.1 | 2025-03-21 | SQL-only install without an extension; `pop()` and `set_vt()` use `clock_timestamp()` | none noted |
| 1.5.0 | 2024-12-30 | `delay` on `send`/`send_batch` accepts `timestamptz` or `integer`; message `headers` on all messages; experimental `conditional` filter on `read`; `queue_visible_length` in metrics; `purge_queue` via `TRUNCATE`; `drop_queue` infers queue type; PG17 support; PG12 dropped | "Potentially breaking": `send(q, msg, '10')` (string literal delay) no longer resolves; use `10` or an explicit `::timestamptz` |
| 1.4.5 | 2024-11-15 | Fix high CPU in `read_with_poll` | none |
| 1.4.4 | 2024-09-17 | pg_partman may live in any schema | none |
| 1.4.3 | 2024-09-16 | pg_partman 5.x support; PG17 tests | none |
| 1.4.2 | 2024-08-19 | Queue names reject `$`, `'`, `;`, `--` | "Breaking change": recommended to create a new queue, migrate clients, then `ALTER EXTENSION pgmq UPDATE TO '1.4.2'` |
| 1.4.1 | 2024-08-15 | Security patch for SQL injection (tembo-io/pgmq issue 295); identifiers via `%I` | security |
| 1.4.0 | 2024-08-05 | `create_partitioned` also partitions the archive; `convert_archive_partitioned` | none noted |
| 1.3.2 / 1.3.3 | 2024-06-04 | Built with PGXS; no shared objects, pure PL/pgSQL; PGXN release | none noted |
| 1.2.0 | 2024-05-21 | Most API implemented in PL/pgSQL; `archive` batch | none noted |
| 1.0.0 | 2023-11-30 | "The PGMQ extension is now stable" | upgrades from 0.x must stop at 1.0.0 (UPDATING.md) |
| 0.25.0 | 2023-09-15 | Functions moved to schema `pgmq` and most renamed | breaking |
| 0.23.0 | 2023-09-03 | `archive()`/`delete()` batch return set of rows | breaking |

Sources for the table: `R`releases via `gh api repos/pgmq/pgmq/releases` (URLs in Sources), `R`UPDATING.md, upgrade scripts `pgmq-extension/sql/pgmq--*.sql`.

Doc drift to avoid copying: README Docker example pins `v1.10.0`; INSTALLATION.md sample output shows version `1.5.1`; README badge says PG 13-18 while the text says 14-18; `functions.md` `read_with_poll` example block is empty; `META.json.in` says PostgreSQL 11.

## Cross-links to our files

All paths under `postgres/references/`. The directory has 102 files; `SKILL.md` index has no pgmq entry; no existing reference file mentions pgmq (grep of `*.md` and `SKILL.md`: zero hits).

| Our file | Header / relevant lines | How the pgmq page should link |
|---|---|---|
| `43-locking.md` | `# PostgreSQL Locking`; covers `NOWAIT and SKIP LOCKED` (heading at line 212), "Building a queue table that consumes rows safely with `SELECT … FOR UPDATE SKIP LOCKED`" (line 38), `### Recipe 4: SKIP LOCKED queue consumer` (line 449), anti-pattern 5 on inconsistent view (line 684). | pgmq `read`/`pop` are exactly this pattern wrapped in functions; link Recipe 4 for the hand-rolled version and note the `SKIP LOCKED` caveat that pgmq `read` ordering is only best-effort under concurrency. |
| `45-listen-notify.md` | `# PostgreSQL LISTEN / NOTIFY`; header note: "LISTEN/NOTIFY is a pub/sub primitive, not a durable message broker or work queue... see 43-locking.md" (line 4); Recipe 2 "Wake a worker queue (NOTIFY as a doorbell)" (line 320); decision row for durable delivery at line 72. | pgmq `enable_notify_insert` is the NOTIFY-as-doorbell design (payload NULL, work stays in the table). Link Recipe 2; reuse the 8000-byte/commit-time delivery/duplicate-suppression rules as background. Note channel names contain dots so `LISTEN` needs double quotes. |
| `99-pg-partman.md` | `# pg_partman — Automated Partition Management`; `create_parent` params (`p_premake` default 4, `p_type` 'range'\|'list' for v5) around lines 114-118; "premake too low + maintenance not running = writes hit DEFAULT partition" (line 726); `partition_data_proc` section (line 341), Recipe "Move data out of default partition" (line 453); line 89: no `shared_preload_libraries` entry needed for pg_partman itself. | `pgmq.create_partitioned` drives `create_parent` and sets `part_config` retention. Link for `premake`, default-partition spill, `partition_data_proc`. Note pgmq passes `p_type := 'native'` for pg_partman 4 and `'range'` for 5; our file states v5 dropped the old types. The `pg_partman_bgw` preload in pgmq's Docker config is optional and separate from `99-pg-partman.md` Integration with pg_cron. |
| `98-pg-cron.md` | `# pg_cron`; Recipe 4 "Cross-database job dispatching to pg_partman" (line 411) using `CALL partman.run_maintenance_proc()`. | Optional alternative to `pg_partman_bgw` for scheduling maintenance of pgmq partitioned queues. Upstream pgmq itself documents only the bgw route. Also relevant: pg_cron can schedule `pgmq.purge_queue` or archive cleanup (not upstream-documented). |
| `44-advisory-locks.md` | `# PostgreSQL Advisory Locks` | pgmq uses `pg_advisory_xact_lock(hashtext('pgmq.queue_' \|\| name))` in create/drop and `pg_try_advisory_xact_lock(hashtextextended(group_key, 0))` in `read_grouped_rr`. The group-key lock is not namespaced by queue name (source reading), so identical group keys in different queues contend on the same advisory key. Worth a gotcha. |
| `28-vacuum-autovacuum.md` | `## Per-Table Tuning` (line 287), `## Autovacuum Trigger Formulas` (line 240) | Queue tables are update/delete heavy; upstream gives no tuning guidance, so any per-table `autovacuum_*` advice on `pgmq.q_<name>` is our derivation. |
| `35-partitioning.md`, `69-extensions.md`, `101-managed-vs-baremetal.md` | not opened in this pass beyond file existence | Candidate links: native partitioning, extension install mechanics, and managed-service availability for the "SQL-only install" path. Content not verified. |

## Sources

Repo and docs (all fetched via `gh api repos/pgmq/pgmq/contents/<path>` with `Accept: application/vnd.github.raw`, or `gh api`):

- https://github.com/pgmq/pgmq
- https://github.com/pgmq/pgmq/blob/main/README.md
- https://github.com/pgmq/pgmq/blob/main/INSTALLATION.md
- https://github.com/pgmq/pgmq/blob/main/UPDATING.md
- https://github.com/pgmq/pgmq/blob/main/SECURITY.md
- https://github.com/pgmq/pgmq/blob/main/mkdocs.yml
- https://github.com/pgmq/pgmq/blob/main/pgmq-extension/sql/pgmq.sql (identical at tag v1.13.1)
- https://github.com/pgmq/pgmq/blob/main/pgmq-extension/pgmq.control
- https://github.com/pgmq/pgmq/blob/main/pgmq-extension/META.json.in
- https://github.com/pgmq/pgmq/blob/main/pgmq-extension/Makefile
- https://github.com/pgmq/pgmq/blob/main/pgmq-extension/README.md (identical to root README)
- https://github.com/pgmq/pgmq/blob/main/pgmq-extension/test/specs/transaction_tests.spec
- https://github.com/pgmq/pgmq/blob/main/pgmq-extension/sql/pgmq--1.9.0--1.10.0.sql
- https://github.com/pgmq/pgmq/blob/main/pgmq-extension/sql/pgmq--1.12.0--1.13.0.sql
- https://github.com/pgmq/pgmq/tree/main/pgmq-extension/sql (all `pgmq--1.x--1.y.sql` scripts grepped for first appearance of symbols)
- https://github.com/pgmq/pgmq/blob/main/docs/api/sql/functions.md
- https://github.com/pgmq/pgmq/blob/main/docs/api/sql/types.md
- https://github.com/pgmq/pgmq/blob/main/docs/fifo-queues.md
- https://github.com/pgmq/pgmq/blob/main/docs/partitioned-queues.md
- https://github.com/pgmq/pgmq/blob/main/docs/topics.md
- https://github.com/pgmq/pgmq/blob/main/.github/workflows/extension_ci.yml
- https://github.com/pgmq/pgmq/blob/main/.github/workflows/release.yml
- https://github.com/pgmq/pgmq/blob/main/.github/CODEOWNERS
- https://github.com/pgmq/pgmq/blob/main/pgmq-rs/Cargo.toml
- https://github.com/pgmq/pgmq/releases (all release bodies via `gh api repos/pgmq/pgmq/releases --paginate`); e.g. https://github.com/pgmq/pgmq/releases/tag/v1.13.1
- https://github.com/pgmq/pgmq-py (release v1.1.4, 2026-09-20; Apache-2.0)
- https://pgmq.github.io/pgmq/ (HTTP 200 only; content taken from the repo `docs/` sources it is built from)
- https://pgxn.org/dist/pgmq/ (shows release 1.13.1)
- https://crates.io/api/v1/crates/pgmq (max_stable_version 0.33.7, max_version 0.34.0-alpha.7)
- https://pypi.org/pypi/pgmq/json (version 1.1.4)
- https://www.postgresql.org/docs/current/extend-extensions.html (`superuser` control-file parameter)

Our repo files read: `postgres/references/43-locking.md`, `45-listen-notify.md`, `99-pg-partman.md`, `98-pg-cron.md`, `44-advisory-locks.md` (headers and targeted greps), `28-vacuum-autovacuum.md` (headings only), `SKILL.md` (grep).

## Not verified

- No runtime test: I could not start the `ghcr.io/pgmq/pg18-pgmq` image (container start was denied by the harness) and did not install the SQL into any database. Every behavior claim comes from reading `pgmq.sql`, the docs and the release notes; none was observed. The recipes are copied from upstream and were not executed.
- PG19: no upstream mention (README, CI matrix 13-18, image matrix 14-18). Whether pgmq works on PG19 is unknown. I did not check whether PG19 has been released.
- Distro packages: upstream documents PGXN, source, Docker and plain SQL only. I found no upstream-documented apt/yum/Homebrew packages and did not search distro repos. Managed-service availability beyond the generic INSTALLATION.md statement ("limited" for extensions) is unverified; Supabase and Tembo are listed as users, which is not an availability statement for any given plan.
- Whether `module_pathname = '$libdir/pgmq'` in `pgmq.control` is vestigial: v1.3.2 release notes say there are no shared objects, and the Makefile builds no module, but I did not inspect an installed package.
- Identity of the maintainer handle: `META.json.in` names Adam Hendel; CODEOWNERS and release authorship show `@ChuckHend`. I did not confirm they are the same person.
- `transaction_tests.out` expected output was not read; the transaction claims rest on the spec's step list and the upstream docs statement for `send_topic`.
- Behavioral inferences marked as source reading, not upstream docs: notify-throttle row contention on concurrent inserts; global (not per-queue) advisory lock keyed on FIFO group in `read_grouped_rr`; queue-name case folding can make `MyQueue` and `myqueue` map to the same tables (only the 1.13.1 notify fix is documented); `leading_partition` being unused in `convert_archive_partitioned`; `purge_queue` using plain `TRUNCATE` (so the identity sequence is not reset and `total_messages` keeps counting; sequence-reset behavior of TRUNCATE is from general PG knowledge, not fetched).
- VACUUM/bloat guidance: none exists upstream; nothing was fabricated.
- `docs/` pages for specific older versions (versioned mike docs) were not fetched; all docs content is from `main`, whose SQL equals v1.13.1.
- Throughput, benchmark or scale claims: not collected (upstream README makes none beyond FIFO table "No limits").
- `pgmq-rs/README.md`, `examples/*.sql`, Python client API surface, and community client quality were not reviewed.

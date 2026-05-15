# pgbench

> [!WARNING] pgbench is a synthetic benchmark, not a load generator that mirrors your workload
> Default scripts (`tpcb-like`, `simple-update`, `select-only`) measure narrow OLTP patterns. Real applications rarely look like TPC-B. Always pair default runs with **custom `.sql` scripts** that mirror your hottest query shapes (cross-reference [`102-skill-cookbook.md`](./102-skill-cookbook.md)). A TPS number from default scripts does not transfer to workloads dominated by analytic SELECTs, wide joins, or columnstore access patterns.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Schema initialization (`-i`)](#schema-initialization--i)
    - [Built-in workloads](#built-in-workloads)
    - [Client + thread arrangement](#client--thread-arrangement)
    - [Custom `.sql` scripts](#custom-sql-scripts)
    - [Meta-command catalog](#meta-command-catalog)
    - [Random distributions](#random-distributions)
    - [Reporting flags](#reporting-flags)
    - [Rate limiting + latency SLA](#rate-limiting--latency-sla)
    - [Connection / protocol](#connection--protocol)
- [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use `pgbench` to:

- Measure baseline TPS / latency on new cluster
- Compare two cluster configs (e.g., `shared_buffers` 8GB vs 16GB)
- Compare two PG majors before upgrade
- Validate autovacuum tuning under sustained write load
- Stress-test a specific query shape via custom `.sql`
- Capacity-plan: at what TPS does p99 exceed SLA?
- Reproduce concurrency bugs (deadlocks, serialization failures)

Do NOT use `pgbench` to:

- Benchmark complex analytical queries (use `EXPLAIN ANALYZE` + real data — [`56-explain.md`](./56-explain.md))
- Measure replication lag under load (run pgbench + monitor `pg_stat_replication` — [`73-streaming-replication.md`](./73-streaming-replication.md))
- Validate application-level behavior (use real app + smaller-scale load)

## Mental Model

Five rules drive every pgbench run.

**Rule 1 — pgbench is the canonical built-in benchmark, not generic load tester.** Ships in `postgresql-contrib`. Default workload = TPC-B-like (four tables: accounts, branches, tellers, history; one transaction = balance update + branch update + teller update + history insert). Default scripts narrow. Custom `.sql` via `-f` makes it general.

**Rule 2 — `-i -s N` initializes four-table dataset at scale N.** Each scale unit = 100K rows in `pgbench_accounts` + 1 branch + 10 tellers. Scale 100 → 10M `pgbench_accounts` rows (~1.3 GB heap). Scale 1000 → 100M rows (~13 GB). Pick scale so dataset exceeds `shared_buffers` if testing disk I/O; pick smaller scale if testing CPU-bound paths.

**Rule 3 — `-c N -j M -T S`: N clients, M threads, S seconds.** Threads ≤ clients (one thread serves multiple clients). Threads beyond `nproc` waste CPU on context-switch. Time-based `-T` preferred over transaction-count `-t` for steady-state.

**Rule 4 — custom `.sql` scripts via `-f` with `\set` + `\setrandom`.** Each script = one "transaction" pgbench reports. Variables interpolated as `:varname`. Multiple `-f` scripts run weighted (`-f script1.sql@70 -f script2.sql@30` runs script1 70% / script2 30%).

**Rule 5 — `--rate N` caps cluster aggregate TPS, `--latency-limit MS` skips long transactions.** Rate-limited runs reveal latency at fixed throughput. Latency-limit reveals what fraction of transactions exceed SLA. Saturated runs (no rate limit) reveal maximum throughput.

## Decision Matrix

| Need | Use | Avoid |
|---|---|---|
| Baseline TPS + latency on new cluster | `pgbench -i -s 100 && pgbench -c 32 -j 8 -T 300 -P 10` | Running without `-T` (transaction-count `-t` makes comparison hard) |
| Compare two configs | Same `-c -j -T -s` on both, diff TPS + latency | Changing multiple variables at once |
| Read-only baseline | `pgbench -S` (select-only built-in) | `-S` then claiming write throughput |
| Stress your actual workload | Custom `.sql` via `-f` with bind params via `:var` | Default TPC-B and assuming it represents your app |
| Capacity-plan at SLA | `--latency-limit 50 --rate 5000 -T 600` (cap TPS, check skipped fraction) | Running saturated then claiming "5000 TPS at 50ms" |
| Multi-shape workload (70% read, 30% write) | `-f read.sql@70 -f write.sql@30` | Single mixed script (cannot weight per-shape) |
| Connection overhead | `-C` (reconnect each transaction) | Default (connection-once) when measuring connect cost |
| Test prepared-statement performance | `-M prepared` | `-M simple` then claiming representative latency |
| Test extended protocol | `-M extended` | `-M simple` (default) when app uses `PREPARE` |
| Validate autovacuum tuning | Long run (`-T 3600`) + monitor `pg_stat_user_tables` | Short run (autovacuum may never trigger) |
| Test under PG15+ serialization isolation | `--default-transaction-isolation=serializable` + observe retry counters | Ignoring retries, then claiming SERIALIZABLE TPS |
| Force disconnect-on-error PG17+ | `--exit-on-abort` | Continuing past unexpected aborts (skews TPS) |
| Reproduce HOT-update behavior | Custom script that updates non-indexed columns | Default TPC-B (updates `aid`-related rows) |

**Three smell signals you're benchmarking wrong:**

1. **TPS goes up when scale goes down** — dataset fits in `shared_buffers`, you're measuring memory not disk.
2. **Latency p99 is 50× p50** — usually checkpoint pressure, autovacuum, or lock contention; check `pg_stat_bgwriter`, `pg_stat_progress_vacuum`, `pg_locks`.
3. **`pgbench` host CPU saturated** — `pgbench` itself is the bottleneck. Move to a beefier client machine OR reduce `-c`/`-j` until host has headroom.

## Syntax / Mechanics

Canonical form:

    pgbench [OPTIONS] [DBNAME]

Two modes:

- **Initialize** (`-i`): create + populate four-table schema, then exit. Run once.
- **Run** (no `-i`): execute the workload against existing schema.

Cluster connection via standard libpq env vars (`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`) or `-h -p -U -d`.

### Schema initialization (`-i`)

    pgbench -i -s 100 \
            --partitions=16 \
            --partition-method=hash \
            --foreign-keys \
            mydb

Four tables created:

- `pgbench_accounts` — 100K × scale rows. Wide-ish (aid, bid, abalance, filler).
- `pgbench_branches` — 1 × scale rows.
- `pgbench_tellers` — 10 × scale rows.
- `pgbench_history` — empty at init; written by run.

Init options:

| Flag | Effect | Default |
|---|---|---|
| `-s SCALE` | Scale factor (rows in accounts = 100000 × scale) | 1 |
| `-I SEQ` | Step sequence (drop, table, data, primary, foreign, vacuum) — letters in any combo, e.g., `dtgvp` | full init |
| `--partitions=N` | Partition `pgbench_accounts` into N partitions | 0 (unpartitioned) |
| `--partition-method=METHOD` | `range` or `hash` (default `range`) | `range` |
| `--foreign-keys` | Add FK constraints between accounts/branches/tellers | off |
| `--unlogged-tables` | Create tables as `UNLOGGED` (faster init, lost on crash) | off |
| `--no-vacuum` | Skip post-init VACUUM | runs VACUUM |
| `--tablespace=NAME` | Place tables in named tablespace | default |
| `--index-tablespace=NAME` | Place indexes in named tablespace | default |
| `--initialize-steps=STEPS` | Same as `-I` | full init |

> [!NOTE] PostgreSQL 13
> `--partitions` + `--partition-method` added in PG13. Partitioning the accounts table tests partition pruning + per-partition autovacuum behavior. Cross-reference [`35-partitioning.md`](./35-partitioning.md).

### Built-in workloads

Three built-in scripts available via `-b NAME[@WEIGHT]`:

- `tpcb-like` — default. UPDATE balance + UPDATE branch + UPDATE teller + INSERT history. Mixed read-write. **7 statements per transaction including BEGIN/SELECT/COMMIT.**
- `simple-update` — UPDATE balance + INSERT history (skips teller/branch updates). Lighter contention. **3 statements per transaction.**
- `select-only` — SELECT abalance FROM pgbench_accounts WHERE aid = :aid. Pure read. **1 statement per transaction.**

If no `-b` and no `-f` specified, runs `tpcb-like`.

**Verbatim TPC-B-like script body:**

    \set aid random(1, 100000 * :scale)
    \set bid random(1, 1 * :scale)
    \set tid random(1, 10 * :scale)
    \set delta random(-5000, 5000)
    BEGIN;
    UPDATE pgbench_accounts SET abalance = abalance + :delta WHERE aid = :aid;
    SELECT abalance FROM pgbench_accounts WHERE aid = :aid;
    UPDATE pgbench_tellers SET tbalance = tbalance + :delta WHERE tid = :tid;
    UPDATE pgbench_branches SET bbalance = bbalance + :delta WHERE bid = :bid;
    INSERT INTO pgbench_history (tid, bid, aid, delta, mtime) VALUES (:tid, :bid, :aid, :delta, CURRENT_TIMESTAMP);
    END;

Note `END` = synonym for `COMMIT`. `:scale` is auto-set by pgbench to the dataset scale.

### Client + thread arrangement

`-c N -j M`:

- `N` = number of simulated clients (each = one TCP connection or one server backend).
- `M` = number of OS threads in `pgbench` itself. Each thread serves `N/M` clients via select/poll loop.
- Constraint: `M ≤ N`. `pgbench` errors if violated.

Practical guidance:

- `j = c` only if `c ≤ nproc`. Beyond that, threads waste cycles.
- Typical sweet spot: `j = min(c, nproc)`.
- `c` should match real concurrency expectation. For OLTP via pgBouncer transaction-mode pool, real concurrency = active backends ≈ `default_pool_size`.

Duration:

- `-T S` — run for S seconds (steady-state preferred).
- `-t N` — run N transactions per client (variable wall-clock).

### Custom `.sql` scripts

Custom script = arbitrary SQL + meta-commands in a file:

    -- file: workload.sql
    \set tenant_id random(1, 1000)
    \set order_id random(1, 1000000)
    BEGIN;
    SELECT * FROM orders WHERE tenant_id = :tenant_id AND id = :order_id;
    UPDATE orders SET status = 'shipped' WHERE id = :order_id;
    COMMIT;

Run:

    pgbench -c 32 -j 8 -T 300 -f workload.sql mydb

Each execution of `workload.sql` = one "transaction" in pgbench's TPS count. Statements within share a server backend.

### Meta-command catalog

Inside `.sql` scripts:

| Command | Effect |
|---|---|
| `\set var expr` | Set variable. Arithmetic + functions supported. |
| `\setshell var cmd args` | Set variable from shell command stdout |
| `\sleep N [us|ms|s]` | Sleep N microseconds/milliseconds/seconds |
| `\if expr` / `\elif` / `\else` / `\endif` | Conditional execution |
| `\gset [prefix]` | Capture last query result into variables (one row, named after columns) |
| `\startpipeline` / `\endpipeline` | Pipeline mode (PG14+) |
| `\syncpipeline` | Send sync message in pipeline (PG17+) |

Built-in functions inside `\set`:

- `random(lo, hi)` — uniform integer
- `random_exponential(lo, hi, param)` — exponential distribution
- `random_gaussian(lo, hi, param)` — gaussian distribution
- `random_zipfian(lo, hi, param)` — zipfian distribution
- `permute(i, size [, seed])` — bijection over `[0, size)` for de-correlating sequential ids
- `abs`, `min`, `max`, `mod`, `int`, `double`, `pi`, `sqrt`, `exp`, `ln`, `pow`, `hash`, `hash_murmur2`, `hash_fnv1a`
- Operators: `+`, `-`, `*`, `/`, `%`, `<`, `<=`, `=`, `<>`, `>=`, `>`, `&&`, `||`, `<<`, `>>`, `&`, `|`, `#`, `~`

> [!NOTE] PostgreSQL 14
> `permute()` added. Useful for generating "random" but evenly-distributed IDs without collisions — better than `random()` when you need every ID hit exactly once.

### Random distributions

Three non-uniform options for `\set`:

| Function | Hot-spot behavior | Use for |
|---|---|---|
| `random_uniform(lo, hi)` | Even distribution | Synthetic workloads where every row equally likely |
| `random_exponential(lo, hi, param)` | High param → strong bias toward `lo` | Recent-data heavy access (recent orders, hot users) |
| `random_gaussian(lo, hi, param)` | Bell curve centered in middle | Normal-distributed access (middle-id bias) |
| `random_zipfian(lo, hi, param)` | Power-law (s-shape); few rows get most reads | Modeling celebrity / popular-product workloads |

Default for built-in scripts = uniform. Override with custom `.sql` to test realistic skew.

### Reporting flags

| Flag | Effect |
|---|---|
| `-P SEC` | Progress report every SEC seconds (TPS, latency) |
| `-r` | Per-statement latency at end (--report-per-command alias) |
| `-l` | Log each transaction's start time + latency to file |
| `--aggregate-interval=SEC` | When using `-l`, aggregate log into SEC-second buckets |
| `--log-prefix=PREFIX` | Prefix for log filename |
| `--latency-limit=MS` | Count transactions exceeding MS as "skipped" |
| `--sampling-rate=RATE` | Sample fraction of transactions for `-l` (0.0 to 1.0) |

Output structure (typical):

    transaction type: <builtin: TPC-B (sort of)>
    scaling factor: 100
    query mode: simple
    number of clients: 32
    number of threads: 8
    duration: 300 s
    number of transactions actually processed: 1543210
    latency average = 6.220 ms
    latency stddev = 12.401 ms
    tps = 5144.034312 (without initial connection time)

> [!NOTE] PostgreSQL 18
> Per-script reports now include count of **failed, retried, and skipped** transactions explicitly. Pre-PG18 only the aggregate was visible; PG18+ lets you attribute retries to specific scripts in a multi-script run.

### Rate limiting + latency SLA

`--rate N`:

- Caps aggregate TPS at N transactions per second across all clients.
- Implements Poisson-distributed arrivals (think: load generator dispatches transactions at exponential intervals averaging 1/N seconds).
- Use to test latency at sustainable throughput (e.g., "what's p99 at 5000 TPS?").

`--latency-limit MS`:

- Any transaction starting more than MS ms late (because the schedule queue is backed up) is skipped + reported.
- Only meaningful with `--rate`. Without rate limit, no schedule queue exists.
- Final report shows `number of transactions skipped: X` + `maximum number of tries: Y`.

Combined pattern (capacity test): `--rate 5000 --latency-limit 50` runs at 5000 TPS target, skips transactions whose schedule slips past 50ms. If skipped fraction > 1%, cluster cannot sustain 5000 TPS within 50ms SLA.

### Pipeline mode

PG14+ introduced libpq pipeline mode (cross-reference [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md)). pgbench exposes via `\startpipeline` / `\endpipeline`:

    -- file: pipelined.sql
    \set aid random(1, 100000)
    \startpipeline
    SELECT abalance FROM pgbench_accounts WHERE aid = :aid;
    UPDATE pgbench_accounts SET abalance = abalance + 1 WHERE aid = :aid;
    \endpipeline

Inside the pipeline, statements queued + sent in batches without waiting for individual responses. Reduces round-trip latency on high-RTT networks.

> [!NOTE] PostgreSQL 17
> `\syncpipeline` meta-command added — sends a sync message in the middle of a pipeline. Useful for breaking a long pipeline into commit boundaries without ending it. Pre-PG17 the only way to sync was `\endpipeline`.

Restriction: cannot mix transaction-control statements (BEGIN/COMMIT) inside a pipeline block — the pipeline is its own transaction unit.

### Connection / protocol

`-M PROTOCOL`:

- `simple` (default) — plain `Q` queries (libpq simple-query protocol).
- `extended` — `Parse` + `Bind` + `Execute` (extended protocol, no statement reuse).
- `prepared` — `PREPARE` once per client, then `Execute` (statement reuse, plan reuse).

`-C` — reconnect for every transaction. Measures connection-establishment overhead. Without `-C` (default), each client connects once and reuses the connection. Use `-C` only to baseline connection-cost contribution to latency.

> [!NOTE] PostgreSQL 14
> `pgbench -C` now correctly includes disconnection time in measured reconnection overhead. Pre-PG14 numbers under `-C` were artificially low.

> [!NOTE] PostgreSQL 17
> `-d` flag remapped: `--dbname=DB` now uses `-d`; debug mode moved to `--debug`. Pre-PG17 scripts using `-d` for debug fail silently in PG17+.

## Per-Version Timeline

| Version | pgbench changes |
|---|---|
| **PG14** | `permute()` function for bijective id mapping; `-C` reconnect overhead now includes disconnection time |
| **PG15** | Automatic retry on serialization failures and deadlocks (cross-reference [`42-isolation-levels.md`](./42-isolation-levels.md)) |
| **PG16** | No pgbench-specific release-note items |
| **PG17** | `-d` reserved for `--dbname` (debug → `--debug`); `--exit-on-abort` flag added; `\syncpipeline` meta-command for pipeline-mode sync |
| **PG18** | Per-script reports now include failed/retried/skipped transaction counts |

> [!NOTE] PostgreSQL 15
> Retry behavior is opt-in via `--max-tries=N` (default 1 = no retry). When set, pgbench retries on `serialization_failure` or `deadlock_detected`. Final report shows `number of transactions retried: X` and `total number of retries: Y`.

## Examples / Recipes

### Recipe 1 — baseline TPC-B-like benchmark

The "what TPS can my cluster sustain" run.

    # initialize at scale 100 (~1.3 GB heap)
    pgbench -i -s 100 mydb

    # run for 5 minutes, 32 clients, 8 threads, progress every 10s
    pgbench -c 32 -j 8 -T 300 -P 10 mydb

Sized so dataset is bigger than `shared_buffers` if cluster has < 2 GB. Bump `-s` to 1000 for ~13 GB dataset to test disk-bound paths.

### Recipe 2 — read-only baseline for comparison

When you change `random_page_cost` or `effective_io_concurrency`, run read-only first to isolate read-path impact:

    pgbench -S -c 32 -j 8 -T 300 -P 10 mydb

`-S` runs select-only built-in. If TPS doesn't move, your change didn't touch the read path.

### Recipe 3 — custom OLTP script with bind parameters

Mirror your real "look up customer + place order" pattern:

    -- file: order.sql
    \set customer_id random(1, 100000)
    \set product_id random(1, 50000)
    \set qty random(1, 5)

    BEGIN;
    SELECT email FROM customers WHERE id = :customer_id;
    INSERT INTO orders (customer_id, product_id, qty, status)
      VALUES (:customer_id, :product_id, :qty, 'pending')
      RETURNING id \gset
    INSERT INTO order_audit (order_id, action) VALUES (:id, 'created');
    COMMIT;

Run with `-M prepared` to enable statement reuse (more representative of pooled app):

    pgbench -f order.sql -c 32 -j 8 -T 300 -M prepared -P 10 mydb

`\gset` captures the `RETURNING id` into `:id` for use in the next statement.

### Recipe 4 — saturated vs rate-limited test

Saturated (find max TPS):

    pgbench -c 64 -j 16 -T 300 -P 10 mydb

Rate-limited at 75% of max with SLA check:

    pgbench -c 64 -j 16 -T 300 -P 10 --rate=4000 --latency-limit=50 mydb

If `number of transactions skipped` < 1% of total and p99 < 50ms, the cluster sustainably handles 4000 TPS. If skipped > 5%, lower the rate.

### Recipe 5 — multi-script weighted workload

70% reads, 25% updates, 5% inserts:

    pgbench \
      -f read.sql@70 \
      -f update.sql@25 \
      -f insert.sql@5 \
      -c 32 -j 8 -T 300 -P 10 \
      -M prepared mydb

Weights are integer ratios, not percentages — `@70 @25 @5` gives 70/100 ratio. Each transaction picks one script per draw based on weight.

### Recipe 6 — per-statement latency breakdown

When TPS is acceptable but p99 is bad, find the slow statement:

    pgbench -f workload.sql -c 32 -j 8 -T 300 -r mydb

Output adds per-statement section:

    statement latencies in milliseconds and failures:
       0.012  \set tenant_id random(1, 1000)
       0.013  \set order_id random(1, 1000000)
       0.041  BEGIN;
       3.142  SELECT * FROM orders WHERE tenant_id = :tenant_id AND id = :order_id;
      14.832  UPDATE orders SET status = 'shipped' WHERE id = :order_id;
       0.124  COMMIT;

`-r` adds overhead (clock_gettime per statement). Use to find culprits; remove for final TPS numbers.

### Recipe 7 — aggregate log for time-series analysis

Capture latency distribution every 10 seconds for plotting:

    pgbench -f workload.sql -c 32 -j 8 -T 600 \
            -l --aggregate-interval=10 \
            --log-prefix=mytest mydb

Produces `mytest.<pid>` files with one line per 10-second bucket: timestamp, transaction count, sum of latency, sum-of-squares of latency, min latency, max latency. Load into pandas / Grafana for p50/p99 over time.

### Recipe 8 — validate autovacuum tuning under sustained load

Run long enough for autovacuum to trigger and complete several cycles:

    pgbench -i -s 100 mydb
    pgbench -c 16 -j 4 -T 3600 -P 60 mydb &

    # in another shell, monitor:
    watch -n 5 'psql -c "SELECT relname, n_tup_upd, n_dead_tup, last_autovacuum FROM pg_stat_user_tables WHERE relname LIKE '\''pgbench_%'\'';"'

If `n_dead_tup` grows unbounded or `last_autovacuum` is stale, autovacuum isn't keeping up. Tune `autovacuum_vacuum_scale_factor` on `pgbench_accounts` per [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md).

### Recipe 9 — connection-establishment overhead

Measure cost of new connections:

    # connection pooled (default)
    pgbench -S -c 32 -j 8 -T 60 mydb
    # → tps = 15000

    # reconnect every transaction
    pgbench -S -c 32 -j 8 -T 60 -C mydb
    # → tps = 2000 (or lower)

The 7-10× drop quantifies the case for pgBouncer. Cross-reference [`80-connection-pooling.md`](./80-connection-pooling.md) and [`81-pgbouncer.md`](./81-pgbouncer.md).

### Recipe 10 — PG15+ test SERIALIZABLE with retries

Stress-test SSI conflict resolution:

    pgbench \
      -f workload.sql \
      -c 32 -j 8 -T 300 \
      --default-isolation-level=serializable \
      --max-tries=10 -P 10 mydb

Final report shows:

    number of transactions retried: 8421 (5.4%)
    total number of retries: 12053

If retry % too high, your access pattern has too much overlap for SERIALIZABLE — restructure transactions or downgrade to READ COMMITTED.

### Recipe 11 — PG17+ `--exit-on-abort` for crash detection

When testing a fragile state, exit immediately on first abort:

    pgbench -f workload.sql -c 32 -j 8 -T 300 --exit-on-abort mydb

Pre-PG17, pgbench tolerated client aborts and continued. Useful for catching server-side errors (deadlocks, OOM-killed backends, lost connections) without filtering through final-report counters.

### Recipe 12 — compare two PG versions before upgrade

Run identical workload against PG16 and PG17 clusters:

    # PG16 cluster on port 5416
    pgbench -i -s 100 -h pg16-host -p 5416 mydb
    pgbench -f workload.sql -c 32 -j 8 -T 600 -P 60 \
            -h pg16-host -p 5416 \
            --log-prefix=pg16-result mydb

    # PG17 cluster on port 5417 (identical hardware + config)
    pgbench -i -s 100 -h pg17-host -p 5417 mydb
    pgbench -f workload.sql -c 32 -j 8 -T 600 -P 60 \
            -h pg17-host -p 5417 \
            --log-prefix=pg17-result mydb

Diff the aggregate-interval logs. Material differences flag upgrade-time regressions before production.

### Recipe 13 — conditional logic in scripts via `\if`

Run a slow path only N% of the time:

    -- file: mixed.sql
    \set roll random(1, 100)
    \set aid random(1, 100000)

    \if :roll <= 95
      -- 95%: fast path
      SELECT abalance FROM pgbench_accounts WHERE aid = :aid;
    \else
      -- 5%: slow path with join + index scan
      SELECT a.abalance, b.bbalance
        FROM pgbench_accounts a
        JOIN pgbench_branches b ON a.bid = b.bid
       WHERE a.aid = :aid;
    \endif

Useful for simulating workload mix with shared variable state (e.g., the same `:aid` used by both branches). Multi-script `@WEIGHT` runs different scripts per transaction; `\if` lets one script branch internally.

### Recipe 14 — partial init for re-running tests

When iterating on tuning, skip the expensive parts:

    # full init (slow)
    pgbench -i -s 100 mydb

    # later: re-init data only, keep schema + indexes
    pgbench -i -s 100 -I gv mydb

`-I` step letters:

- `d` — drop existing tables
- `t` — create tables
- `g` — generate data
- `G` — generate data (client-side, slower but cross-version safe)
- `p` — create primary keys
- `f` — create foreign keys
- `v` — vacuum after load

`-I dtgvp` = full default. `-I gv` = re-generate data + vacuum, keep schema.

### Recipe 15 — PG18+ per-script failure reporting

In a multi-script run, identify which script aborts most:

    pgbench \
      -f read.sql@70 \
      -f write.sql@30 \
      -c 32 -j 8 -T 300 \
      --max-tries=5 mydb

PG18+ final report attributes counters per script:

    SQL script 1: read.sql
     - weight: 70 (targets 70.0%)
     - 1421000 transactions (70.05% of total, tps = 4736.667)
     - 0 failed transactions
     - 0 retried transactions

    SQL script 2: write.sql
     - weight: 30 (targets 30.0%)
     - 608000 transactions (29.95% of total, tps = 2026.667)
     - 1842 failed transactions (0.30%)
     - 421 retried transactions

Pre-PG18 only showed aggregate failed-count. PG18+ lets you isolate which script under what conditions.

## Gotchas / Anti-patterns

1. **pgbench client overhead becomes the bottleneck on small queries.** A single-statement SELECT at 50K TPS may have pgbench's main loop using more CPU than the server. Use a beefier client OR run pgbench on the DB host (acceptable for benchmarking, never for production load testing).

2. **`-j > -c` is rejected with error.** Threads must be ≤ clients. Set `-j = min(-c, nproc)`.

3. **`-s` without `-i` does nothing.** `-s` only applies to `-i` initialization. During a run, `-s` is ignored (and pgbench infers scale from existing data).

4. **Default builtin queries are not your workload.** TPC-B-like is a 1991 banking schema. Modern OLTP workloads have larger tables, more indexes, JSON columns, FK cascades, partitioning. Always write a custom `.sql`.

5. **`--rate` doesn't slow individual clients.** It caps **aggregate** TPS. Each client still runs as fast as it can; the rate limiter just delays new transactions globally.

6. **Per-statement reporting (`-r`) overhead skews latency.** Adds ~1-5% to measured latencies due to extra `clock_gettime`. Use to find culprits; remove for final TPS numbers.

7. **pgbench's connection-handling is not a real pooler.** It just opens connections once and keeps them. To test a pooler, run pgbench through pgBouncer/Odyssey instead of direct to Postgres.

8. **`--foreign-keys` massively slows init.** Adds FK from accounts.bid → branches, tellers.bid → branches, history.aid/bid/tid → respective tables. For scale 1000, init time goes from ~5min to ~30min. Skip unless testing FK validation cost.

9. **`--unlogged-tables` init faster but data lost on crash.** Useful for one-shot benchmarks; never for real durability tests.

10. **Random distribution defaults are uniform.** Real workloads almost never are. Use `random_exponential` or `random_zipfian` to model recency or popularity bias.

11. **`--progress` shows pgbench-side TPS, not server-side metrics.** WAL bytes, buffer-pool hits, autovacuum activity invisible. Monitor server-side `pg_stat_*` separately.

12. **PG17 `-d` flag remap breaks pre-PG17 scripts.** `-d` was `--debug`; now it's `--dbname`. Pre-PG17 scripts using `pgbench -d mydb` silently treat `mydb` as the database name (was: enable debug, then look for default db). Test scripts on PG17 before relying.

13. **`--latency-limit` is per-script, per-transaction, not per-statement.** A 500ms script with one 450ms statement at 50ms limit is skipped entirely. Use `-r` to find per-statement latency.

14. **`-D var=value` sets variable on command line.** Useful for parameterizing scripts without editing them, e.g., `-D tenant=42`. Inside the script: `\set base_tenant :tenant`.

15. **Multi-script weighted is per-transaction, not per-time-window.** Over 1000 transactions with `@70 @30`, expect ~700 of script1 and ~300 of script2. Over 10 transactions, the distribution may be 8/2 or 6/4 by chance.

16. **Connection-retry behavior changes between versions.** Pre-PG15, no retry on serialization failures (aborts counted as failed). PG15+ retries with `--max-tries`. Pre-PG15 numbers under SERIALIZABLE are not comparable to PG15+ numbers.

17. **Custom scripts must include `BEGIN`/`COMMIT` if they need a multi-statement transaction.** Without them, each statement is its own auto-commit transaction. pgbench reports the whole script as one "transaction" regardless of explicit BEGIN/COMMIT, but server-side behavior differs (locks, snapshot scope).

18. **`-M extended` uses Parse/Bind/Execute but doesn't reuse plans.** Every transaction reparses. For plan-cache testing, use `-M prepared`.

19. **`-M prepared` first call has parse cost.** The first transaction per client pays the parse; subsequent transactions reuse. Short runs (`-T 10`) measure mostly first-call overhead. Use `-T 300` or longer for steady-state.

20. **PG14 disconnection-time fix changed `-C` numbers retroactively.** A "5000 TPS under -C" baseline from PG13 may show as "4500 TPS under -C" on PG14 not because of regression, but because PG14 measures the previously-omitted disconnect time.

21. **PG18 per-script reporting changed output format.** Tools parsing `pgbench` output may need to handle new "failed transactions" / "retried transactions" lines per script.

22. **Default pgbench tables are small at low scale — fit in shared_buffers.** Scale 1 → 13MB total. Scale 10 → 130MB. With `shared_buffers=8GB`, everything fits up to scale 600+. To measure disk I/O, set scale ≥ 1000 (or run on a host with smaller `shared_buffers`).

23. **pgbench measures throughput on its side, not server-side ops.** A TPS number doesn't tell you WAL bytes, replication lag, autovacuum cycles, or buffer-pool churn. Always run with `-P` AND monitor server-side via `pg_stat_*` views in parallel. Cross-reference [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) and [`82-monitoring.md`](./82-monitoring.md).

## See Also

- [`13-cursors-and-prepares.md`](./13-cursors-and-prepares.md) — `-M prepared` plan caching
- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — validating autovacuum tuning via pgbench Recipe 8
- [`33-wal.md`](./33-wal.md) — measuring WAL volume during pgbench runs
- [`34-checkpoints-bgwriter.md`](./34-checkpoints-bgwriter.md) — checkpoint pressure shows up as latency spikes in pgbench `-P` output
- [`35-partitioning.md`](./35-partitioning.md) — `--partitions` + `--partition-method`
- [`42-isolation-levels.md`](./42-isolation-levels.md) — PG15+ `--max-tries` retry on serialization failure
- [`43-locking.md`](./43-locking.md) — diagnosing pgbench-induced lock contention
- [`54-memory-tuning.md`](./54-memory-tuning.md) — interpreting pgbench TPS shifts after `shared_buffers` / `work_mem` changes
- [`56-explain.md`](./56-explain.md) — analyzing individual pgbench statements
- [`57-pg-stat-statements.md`](./57-pg-stat-statements.md) — query-level view of pgbench workload
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — server-side metrics during pgbench
- [`80-connection-pooling.md`](./80-connection-pooling.md) — Recipe 9 connection-overhead comparison
- [`81-pgbouncer.md`](./81-pgbouncer.md) — running pgbench through pgBouncer
- [`82-monitoring.md`](./82-monitoring.md) — capturing pgbench-period metrics for trend analysis
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — Recipe 12 cross-version comparison
- [`53-server-configuration.md`](./53-server-configuration.md) — GUCs discussed in tuning context (`shared_buffers`, `checkpoint_completion_target`)
- [`102-skill-cookbook.md`](./102-skill-cookbook.md) — capacity-planning recipes using pgbench

## Sources

[^pgbench-docs]: pgbench reference. https://www.postgresql.org/docs/16/pgbench.html
[^pgbench-docs-17]: pgbench reference (PG17). https://www.postgresql.org/docs/17/pgbench.html
[^pgbench-docs-18]: pgbench reference (PG18). https://www.postgresql.org/docs/18/pgbench.html
[^pg14-permute]: "Add pgbench `permute()` function to randomly shuffle values." PG14 release notes. https://www.postgresql.org/docs/release/14.0/
[^pg14-disconnect]: "Include disconnection times in the reconnection overhead measured by pgbench with `-C`." PG14 release notes. https://www.postgresql.org/docs/release/14.0/
[^pg15-retry]: "Allow pgbench to retry after serialization and deadlock failures." PG15 release notes. https://www.postgresql.org/docs/release/15.0/
[^pg17-d]: PG17 release notes — `-d` flag reserved for `--dbname`, debug now `--debug`. https://www.postgresql.org/docs/release/17.0/
[^pg17-exit]: PG17 release notes — `--exit-on-abort` flag added. https://www.postgresql.org/docs/release/17.0/
[^pg17-syncpipeline]: PG17 release notes — `\syncpipeline` meta-command for pipeline-mode sync. https://www.postgresql.org/docs/release/17.0/
[^pg18-perscript]: PG18 release notes — per-script reports include failed/retried/skipped transaction counts. https://www.postgresql.org/docs/release/18.0/

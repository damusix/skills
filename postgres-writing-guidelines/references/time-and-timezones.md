# Time & Timezones


Always `timestamptz`. Always UTC at rest. Display in the user's zone, never store in it. Postgres has a clean time model; misuse causes data corruption that's hard to undo.

## Table of Contents

- [Always TIMESTAMPTZ, Never TIMESTAMP](#always-timestamptz-never-timestamp)
- [The clock_timestamp / now / statement_timestamp Family](#the-clock_timestamp--now--statement_timestamp-family)
- [Date vs Timestamp](#date-vs-timestamp)
- [Intervals and Arithmetic](#intervals-and-arithmetic)
- [Bucketing with date_trunc and AT TIME ZONE](#bucketing-with-date_trunc-and-at-time-zone)
- [Generating Time Series](#generating-time-series)
- [Range Types for Periods](#range-types-for-periods)
- [Common Mistakes](#common-mistakes)

---

## Always TIMESTAMPTZ, Never TIMESTAMP

There are two timestamp types in Postgres:

- `timestamp` (also written `timestamp without time zone`) — stores a wall-clock time with no zone information. Ambiguous and dangerous.
- `timestamptz` (also written `timestamp with time zone`) — stores a UTC instant. Conversions in/out apply the session's `TIMEZONE` setting.

**Always use `timestamptz`.** The "without time zone" form leads to silent data corruption when callers in different zones write or read — you have no way to know what wall-clock zone the stored value was meant for.

Standard domain:

    CREATE DOMAIN ts_now AS timestamptz NOT NULL DEFAULT clock_timestamp();

If you genuinely need "a wall-clock time with no associated zone" — for example, "every Monday at 9:00 in the user's local zone" — store `time` plus a separate zone column, not `timestamp`.

## The clock_timestamp / now / statement_timestamp Family

Postgres has several "current time" functions; they differ in *when* they sample:

| Function | When sampled | Stable within |
|----------|--------------|---------------|
| `clock_timestamp()` | Right now (system clock) | Single call |
| `statement_timestamp()` | Start of current statement | One statement |
| `transaction_timestamp()` / `now()` | Start of current transaction | One transaction |
| `current_timestamp` | Start of transaction (SQL standard alias for `now()`) | One transaction |

For audit columns and "when did this row land" use `clock_timestamp()` — you want true wall-clock, not transaction-start. For deterministic "as of" in a batch, `transaction_timestamp()` or `now()` so all rows in the transaction share a timestamp.

Standard pattern:

    CREATE TABLE event_log (
        ...,
        created_at ts_now NOT NULL,    -- defaults to clock_timestamp()
        updated_at ts_now NOT NULL
    );

## Date vs Timestamp

When the time-of-day genuinely doesn't matter — birthdays, holidays, billing month — use `date`, not `timestamptz`:

    CREATE TABLE customer (
        ...,
        date_of_birth date,
        anniversary  date
    );

Storing a "date" as a `timestamptz` at midnight is wrong — midnight in *which zone*? Use `date` and avoid the zone question entirely.

## Intervals and Arithmetic

    SELECT clock_timestamp() + INTERVAL '1 day';
    SELECT clock_timestamp() - INTERVAL '90 days';
    SELECT clock_timestamp() + INTERVAL '1 month';   -- DST-aware

`INTERVAL '1 month'` is calendar-aware (Feb 1 → Mar 1, not "Feb 1 + 30 days"). For exact second/millisecond math, use `INTERVAL '30 seconds'`.

Difference between two timestamps:

    SELECT finished_at - started_at AS duration FROM job_log;
    -- Returns INTERVAL; cast to milliseconds for storage:
    SELECT EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000 AS duration_ms;

## Bucketing with date_trunc and AT TIME ZONE

`date_trunc` collapses a timestamp to a coarser granularity:

    SELECT date_trunc('hour', occurred_at), COUNT(*)
    FROM event_log
    GROUP BY 1;

**Crucial detail:** `date_trunc('day', ts)` truncates in UTC by default. For "day in the user's local zone":

    SELECT date_trunc('day', occurred_at AT TIME ZONE 'America/New_York') AS local_day,
           COUNT(*)
    FROM event_log
    GROUP BY 1;

`AT TIME ZONE 'X'` on a `timestamptz` produces a `timestamp` (no zone) representing the wall-clock in zone X. Then `date_trunc` operates on that.

To convert back to `timestamptz`:

    SELECT (date_trunc('day', occurred_at AT TIME ZONE 'America/New_York'))
           AT TIME ZONE 'America/New_York' AS day_start;

## Generating Time Series

`generate_series` builds a virtual time axis — invaluable for gap-filling reports:

    SELECT day, COALESCE(c.count, 0) AS event_count
    FROM generate_series(
        clock_timestamp() - INTERVAL '30 days',
        clock_timestamp(),
        INTERVAL '1 day'
    ) AS day
    LEFT JOIN (
        SELECT date_trunc('day', occurred_at) AS day, COUNT(*) AS count
        FROM event_log
        WHERE occurred_at >= clock_timestamp() - INTERVAL '30 days'
        GROUP BY 1
    ) c USING (day);

Without `generate_series`, days with zero events would be missing from the result entirely.

## Range Types for Periods

Postgres has `tstzrange` for time periods — better than two columns for "during":

    CREATE TABLE reservation (
        reservation_id bigserial PRIMARY KEY,
        room_id        room_id NOT NULL,
        during         tstzrange NOT NULL,

        -- No two reservations of the same room can overlap
        EXCLUDE USING GIST (room_id WITH =, during WITH &&)
    );

The `EXCLUDE` constraint prevents overlapping ranges atomically — no application-level locking dance needed. Pairs with GiST indexes for fast overlap queries.

Common range operators:

- `range_a && range_b` — overlaps
- `range_a @> point` — contains
- `range_a -|- range_b` — adjacent

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using `timestamp` (without timezone) for app data | Use `timestamptz` |
| Storing dates as `timestamptz` at midnight | Use `date` |
| `date_trunc('day', ts) WHERE ts >= today_local` without `AT TIME ZONE` | Use `ts AT TIME ZONE 'X'` |
| `now()` for "right now in a long-running batch" | Use `clock_timestamp()` if you want real-time samples |
| `EXTRACT(EPOCH FROM ...)` to get milliseconds, dropping fractional | Multiply by 1000, cast to integer |
| Two columns for `start_at`/`end_at` when you'd query overlaps | Use `tstzrange` + `EXCLUDE` |
| `INTERVAL '30 days'` for "one month" | Use `INTERVAL '1 month'` for calendar math |
| Storing timezone offset in user-zone-naive columns | Store UTC, convert at the read boundary |
| Comparing `timestamptz` to a string literal without explicit cast | `ts >= '2026-01-01T00:00:00Z'::timestamptz` |

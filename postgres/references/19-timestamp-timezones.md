# Timestamps, Time Zones, Intervals


## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Type Catalog](#type-catalog)
    - [timestamptz vs timestamp without time zone](#timestamptz-vs-timestamp-without-time-zone)
    - [AT TIME ZONE and AT LOCAL](#at-time-zone-and-at-local)
    - [interval and Mixed-Unit Arithmetic](#interval-and-mixed-unit-arithmetic)
    - [date_trunc, date_bin, EXTRACT, date_part](#date_trunc-date_bin-extract-date_part)
    - [age, justify_days, justify_hours, justify_interval](#age-justify_days-justify_hours-justify_interval)
    - [Constructor Functions: make_date / make_time / make_timestamp / make_timestamptz / make_interval](#constructor-functions)
    - [Now Functions: clock vs statement vs transaction](#now-functions-clock-vs-statement-vs-transaction)
    - [to_char, to_timestamp, to_date](#to_char-to_timestamp-to_date)
    - [Special Values: infinity, epoch, now, today, tomorrow, yesterday, allballs](#special-values)
    - [TimeZone GUC and Time Zone Names](#timezone-guc-and-time-zone-names)
    - [DateStyle, IntervalStyle, Output Formats](#datestyle-intervalstyle-output-formats)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)


## When to Use This Reference

Reach for this file whenever you need to:

- Pick between `timestamp`, `timestamptz`, `date`, `time`, or `interval` for a new column
- Translate values across time zones with `AT TIME ZONE` or PG17's `AT LOCAL`
- Bucket rows into time windows for analytics (`date_trunc`, `date_bin`, generated buckets)
- Reason about DST: when adding `interval '1 day'` shifts you 23 or 25 hours instead of 24
- Choose between `now()` / `statement_timestamp()` / `clock_timestamp()` for audit timestamps, microbenchmarks, or sequence-of-events ordering
- Format and parse with `to_char` / `to_timestamp` / `to_date`
- Pick the right "no end date" sentinel (use `'infinity'::timestamptz`, never `NULL` or `'9999-12-31'`)
- Audit a schema for `timestamp without time zone` columns that should be migrated to `timestamptz`

Cross-reference [`14-data-types-builtin.md`](./14-data-types-builtin.md) for the broader scalar-type matrix, [`15-data-types-custom.md`](./15-data-types-custom.md) for `tsrange`/`tstzrange` and the EXCLUDE-USING-gist non-overlap pattern, and [`35-partitioning.md`](./35-partitioning.md) for time-range partition sizing.


## Mental Model

Five rules drive every decision in this file:

1. **Always use `timestamptz`, never `timestamp without time zone`** — unless you have a documented reason. The naïve type stores a wall-clock string with no UTC anchor, so "events in the last hour" is unanswerable across DST transitions and across users in different zones. `timestamptz` stores a UTC instant and renders in any session zone via `AT TIME ZONE`.

2. **`timestamptz` is *not* "stores a time zone."** It stores a UTC instant. The original input zone is discarded after conversion. Its name is misleading; think of it as `timestamp_utc` if that helps.[^datetime]

3. **Intervals carry three independent fields — months, days, microseconds — for a reason.** `1 month`, `30 days`, and `2592000 seconds` are *different values* because months vary in length and days can be 23 / 24 / 25 hours under DST.[^datetime] Mixing them in arithmetic gives results that depend on the anchor date.

4. **`now()` is the transaction start time, not the wall clock.** It does not advance during the transaction. Use `clock_timestamp()` for "time when this expression evaluated."[^datetime-fns]

5. **Use `'infinity'::timestamptz` for unbounded future, not `NULL` or `'9999-12-31'`.** Comparison operators work correctly (`x < 'infinity'` is true for any real value), it sorts after every real timestamp, indexes work, and `WHERE expires_at > now()` evaluates correctly without NULL branches.[^datetime]


## Decision Matrix

| You need to store… | Use | Avoid | Why |
|---|---|---|---|
| An instant in time (event happened, row created, deadline) | `timestamptz` | `timestamp` | Only `timestamptz` survives session-zone changes and DST |
| A wall-clock that is not anchored to UTC ("the meeting starts at 10am local in whatever zone the user views") | `timestamp` + separate `text` zone column | `timestamptz` alone | timestamptz throws away the original zone after converting |
| A calendar date with no time | `date` | `timestamp 00:00:00` | Smaller (4 bytes vs 8), no zone confusion, indexes are tighter |
| Time-of-day with no date (store hours, like a recurring meeting) | `time without time zone` | `time with time zone` | `timetz` is "rarely the right type" per the docs[^datetime]; date+zone is needed to determine DST |
| A duration ("1 month", "5 days", "30 minutes") | `interval` | `numeric` seconds | Preserves calendar/wall-clock semantics; date arithmetic works |
| An age in years ("user is 42 years old") | `interval` (via `age()`) | `extract(year from ...)` arithmetic | `age()` handles partial-year boundaries correctly |
| Time bucketed for analytics ("hour of event") | `timestamptz` + `date_trunc('hour', t, 'UTC')` or `date_bin` | A separate `bucket` column | `date_trunc` is immutable when called with explicit zone (PG16+);[^pg16-trunc] use a generated column or expression index |
| Open-ended future ("subscription has no expiry") | `expires_at timestamptz`, set to `'infinity'::timestamptz` | `NULL` or `'9999-12-31 23:59:59'` | Comparison semantics are correct; query `WHERE expires_at > now()` works without OR-NULL branches |
| Year/month only (billing period) | `date` truncated to month-start, or `int year, int month` | `text 'YYYY-MM'` | Date arithmetic + indexes work natively |
| A time range (booking window, validity period) | `tstzrange` | Two columns + manual checks | See [`15-data-types-custom.md`](./15-data-types-custom.md) for the EXCLUDE-USING-gist non-overlap pattern |


## Syntax / Mechanics


### Type Catalog

From the date/time types table:[^datetime]

| Type | Storage | Range | Resolution | Aliases |
|---|---|---|---|---|
| `timestamp [(p)] [without time zone]` | 8 bytes | 4713 BC to 294276 AD | 1 µs (with `p` 0–6) | — |
| `timestamp [(p)] with time zone` | 8 bytes | 4713 BC to 294276 AD | 1 µs (with `p` 0–6) | `timestamptz` |
| `date` | 4 bytes | 4713 BC to 5874897 AD | 1 day | — |
| `time [(p)] [without time zone]` | 8 bytes | 00:00:00 to 24:00:00 | 1 µs | — |
| `time [(p)] with time zone` | 12 bytes | 00:00:00+1559 to 24:00:00-1559 | 1 µs | `timetz` |
| `interval [fields] [(p)]` | 16 bytes | -178000000 years to +178000000 years | 1 µs | — |

*"The SQL standard requires that writing just `timestamp` be equivalent to `timestamp without time zone`, and PostgreSQL honors that behavior. `timestamptz` is accepted as an abbreviation for `timestamp with time zone`; this is a PostgreSQL extension."*[^datetime]

> [!WARNING] `time with time zone` is rarely correct
> The docs explicitly say: *"we recommend using date/time types that contain both date and time when using time zones. We do not recommend using the type `time with time zone` (though it is supported by PostgreSQL for legacy applications and for compliance with the SQL standard)."*[^datetime] Without a date you cannot determine whether DST applies.


### timestamptz vs timestamp without time zone

The behavior gap is the central fact of this file. From the docs:[^datetime]

> *"In a value that has been determined to be `timestamp without time zone`, PostgreSQL will silently ignore any time zone indication. That is, the resulting value is derived from the date/time fields in the input string, and is not adjusted for time zone."*

vs:

> *"For `timestamp with time zone` values, an input string that includes an explicit time zone will be converted to UTC … using the appropriate offset for that time zone. If no time zone is stated in the input string, then it is assumed to be in the time zone indicated by the system's `TimeZone` parameter, and is converted to UTC using the offset for the `timezone` zone. In either case, the value is stored internally as UTC, and the originally stated or assumed time zone is not retained."*

And on output:

> *"When a `timestamp with time zone` value is output, it is always converted from UTC to the current `timezone` zone, and displayed as local time in that zone."*

Concretely:

    -- Session is America/New_York (UTC-5 in winter)
    SET TimeZone = 'America/New_York';

    SELECT '2026-01-15 10:00'::timestamp;         -- 2026-01-15 10:00:00            (no zone)
    SELECT '2026-01-15 10:00'::timestamptz;       -- 2026-01-15 10:00:00-05         (input assumed local; stored UTC; output local)
    SELECT '2026-01-15 10:00+00'::timestamptz;    -- 2026-01-15 05:00:00-05         (input UTC; stored UTC; output local)

    -- Switch zone, query the same value
    SET TimeZone = 'Asia/Tokyo';
    SELECT '2026-01-15 10:00+00'::timestamptz;    -- 2026-01-15 14:00:00+09         (same instant; rendered in Tokyo)

The `timestamp without time zone` value is unaffected by the session zone — but that is the bug, not the feature. If session A inserts `'2026-01-15 10:00'::timestamp` from New York and session B reads it from Tokyo, both see the same wall-clock string with no way to recover the original instant.


### AT TIME ZONE and AT LOCAL

`AT TIME ZONE` is asymmetric — its meaning depends on the input type:[^datetime-fns]

    timestamp without time zone AT TIME ZONE zone  →  timestamp with time zone
    timestamp with time zone    AT TIME ZONE zone  →  timestamp without time zone
    time with time zone         AT TIME ZONE zone  →  time with time zone

Two opposite operations share one syntax:

- **Naïve → aware**: "treat this wall-clock as if it were observed in this zone, then anchor to UTC."
- **Aware → naïve**: "render this UTC instant as the wall-clock that an observer in this zone would see."

Examples from the docs:

    -- Treat a naive timestamp as Denver local; produce UTC-anchored timestamptz
    SELECT timestamp '2001-02-16 20:38:40' AT TIME ZONE 'America/Denver';
    --   2001-02-17 03:38:40+00

    -- Render a UTC-anchored timestamptz as Denver wall-clock; result is naive
    SELECT timestamp with time zone '2001-02-16 20:38:40-05' AT TIME ZONE 'America/Denver';
    --   2001-02-16 18:38:40

> [!NOTE] PostgreSQL 17
> `AT LOCAL` is shorthand for `AT TIME ZONE <session TimeZone>`.[^pg17-atlocal] *"The syntax `AT LOCAL` may be used as shorthand for `AT TIME ZONE local`, where `local` is the session's `TimeZone` value."*[^pg17-atlocal-docs] Use it inside views or functions that should follow whatever session zone the caller has set, without hardcoding a zone literal.

PG17 `AT LOCAL` example:

    -- Session is America/New_York (UTC-5)
    SELECT TIMESTAMP WITH TIME ZONE '2001-02-16 20:38:40-05' AT LOCAL;
    --   2001-02-16 20:38:40

The zone argument can be either a text name (`'America/Denver'`) or an interval (`INTERVAL '-08:00'`).


### interval and Mixed-Unit Arithmetic

> *"Internally, `interval` values are stored as three integral fields: months, days, and microseconds. These fields are kept separate because the number of days in a month varies, while a day can have 23 or 25 hours if a daylight savings time transition is involved."*[^datetime]

This is the source of every "interval did not do what I expected" surprise.

    SELECT '1 month'::interval = '30 days'::interval;   -- false
    SELECT '1 month'::interval = '4 weeks'::interval;   -- false
    SELECT '1 day'::interval = '24 hours'::interval;    -- false (in DST-relevant arithmetic)
    SELECT '1 day'::interval = '24 hours'::interval;    -- true under simple equality (because no anchor date is involved)

The last two look contradictory. The resolution: equality of two `interval` values compares them by normalizing to a single unit (microseconds-since-epoch-of-a-fixed-date), but **adding** an interval to a `timestamptz` walks the calendar, so DST may apply.

Concrete DST example (US Eastern, spring-forward 2026-03-08 02:00):

    SET TimeZone = 'America/New_York';

    SELECT '2026-03-07 12:00'::timestamptz + '1 day'::interval;
    --   2026-03-08 12:00:00-04   (DST kicked in; wall-clock stayed at 12:00, instant moved 23h)

    SELECT '2026-03-07 12:00'::timestamptz + '24 hours'::interval;
    --   2026-03-08 13:00:00-04   (instant moved exactly 24h; wall-clock advanced to 13:00 because of DST)

`'1 day'` honors the wall clock; `'24 hours'` honors the instant. Either is correct; pick deliberately.

> [!NOTE] PostgreSQL 17
> `interval` now supports `+infinity` and `-infinity` values:[^pg17-interval] *"Allow the `interval` data type to support `+/-infinity` values."* Useful as an "unbounded duration" sentinel without resorting to a `NULL` plus separate boolean flag.

> [!NOTE] PostgreSQL 17
> `ago` is now restricted to appearing only at the end of an `interval` literal, and empty interval units cannot appear multiple times.[^pg17-ago] Pre-PG17 strings like `'-1 ago year'` parsed by accident; they now error.

> [!NOTE] PostgreSQL 15
> Fractional values for an interval unit greater than months now round to the nearest month rather than dropping into days. *"For example, convert `1.99 years` to `2 years`, not `1 year 11 months` as before."*[^pg15-interval]


### date_trunc, date_bin, EXTRACT, date_part

**`date_trunc`** zeros out fields below the chosen precision:[^datetime-fns]

    date_trunc('hour',  TIMESTAMP '2001-02-16 20:38:40')           → 2001-02-16 20:00:00
    date_trunc('year',  TIMESTAMP '2001-02-16 20:38:40')           → 2001-01-01 00:00:00
    date_trunc('day',   TIMESTAMP WITH TIME ZONE '2001-02-16 20:38:40+00')                      → 2001-02-16 00:00:00-05
    date_trunc('day',   TIMESTAMP WITH TIME ZONE '2001-02-16 20:38:40+00', 'Australia/Sydney')  → 2001-02-16 08:00:00-05

Valid fields: `microseconds`, `milliseconds`, `second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`, `decade`, `century`, `millennium`.

> [!NOTE] PostgreSQL 16
> `date_trunc(unit, timestamptz, time_zone)` is now `IMMUTABLE` rather than `STABLE`.[^pg16-trunc] *"This allows the creation of expression indexes using this function."* The two-argument form remains `STABLE` because it depends on session `TimeZone`.

**`date_bin`** (PG14+) buckets a timestamp into stride-width windows aligned to a chosen origin:[^pg14-datebin]

    date_bin('15 minutes', TIMESTAMP '2020-02-11 15:44:17', TIMESTAMP '2001-01-01')             → 2020-02-11 15:30:00
    date_bin('15 minutes', TIMESTAMP '2020-02-11 15:44:17', TIMESTAMP '2001-01-01 00:02:30')   → 2020-02-11 15:32:30

The `stride` must be positive and *cannot contain months or larger units* — variable-length months break the math.

**`EXTRACT(field FROM source)`** returns `numeric` (PG14+; previously `double precision`):[^pg14-extract]

    EXTRACT(hour    FROM TIMESTAMP '2001-02-16 20:38:40')   → 20
    EXTRACT(epoch   FROM TIMESTAMPTZ '2001-02-16 20:38:40+00') → 982355920
    EXTRACT(month   FROM INTERVAL '2 years 3 months')         → 3
    EXTRACT(isodow  FROM DATE '2026-05-11')                   → 1   (Monday=1, Sunday=7)
    EXTRACT(dow     FROM DATE '2026-05-11')                   → 1   (Sunday=0, Saturday=6)

> [!NOTE] PostgreSQL 18
> `EXTRACT()` gained a `WEEK` option, and `EXTRACT(QUARTER ...)` output is improved for negative values (BC dates).[^pg18-extract]

Valid `EXTRACT` fields: `century`, `day`, `decade`, `dow`, `doy`, `epoch`, `hour`, `isodow`, `isoyear`, `julian`, `microseconds`, `millennium`, `milliseconds`, `minute`, `month`, `quarter`, `second`, `timezone`, `timezone_hour`, `timezone_minute`, `week`, `year`.

**`date_part(text, source)`** is the older Ingres-style equivalent of `EXTRACT`. Returns `double precision`. The docs explicitly recommend `EXTRACT`:[^datetime-fns] *"For historical reasons, the `date_part` function returns values of type `double precision`. This can result in a loss of precision in certain uses. Using `extract` is recommended instead."*


### age, justify_days, justify_hours, justify_interval

**`age(timestamp, timestamp)`** subtracts in symbolic year/month/day terms:[^datetime-fns]

    age(timestamp '2001-04-10', timestamp '1957-06-13')   → 43 years 9 mons 27 days
    age(timestamp '1957-06-13')                            → <years/months/days from 1957-06-13 to current_date>

Use this rather than `(t2 - t1)` arithmetic when you want human-readable durations. Plain subtraction returns days+seconds; `age()` returns years+months+days.

**`justify_days(interval)`** converts every 30-day chunk into a month:

    justify_days(interval '1 year 65 days')   → 1 year 2 mons 5 days

**`justify_hours(interval)`** converts every 24-hour chunk into a day:

    justify_hours(interval '50 hours 10 minutes')   → 2 days 02:10:00

**`justify_interval(interval)`** runs both, plus sign normalization:

    justify_interval(interval '1 mon -1 hour')   → 29 days 23:00:00

These are operationally surprising — they may *change the value* in DST-relevant or month-length-relevant arithmetic. Use only when you genuinely want the normalized form (e.g., for human display).


### Constructor Functions

Build values from parts rather than parsing strings:[^datetime-fns]

    make_date(2013, 7, 15)                               → 2013-07-15
    make_time(8, 15, 23.5)                               → 08:15:23.5
    make_timestamp(2013, 7, 15, 8, 15, 23.5)             → 2013-07-15 08:15:23.5
    make_timestamptz(2013, 7, 15, 8, 15, 23.5)           → 2013-07-15 08:15:23.5+01   (uses session TimeZone)
    make_timestamptz(2013, 7, 15, 8, 15, 23.5, 'America/New_York')   → 2013-07-15 13:15:23.5+01

    -- Named-argument form skips defaults (PG14+ accepts negative years for BC):[^pg14-makets]
    make_interval(days => 10)                            → 10 days
    make_interval(years => 1, months => 6)               → 1 year 6 mons
    make_interval(weeks => 2, days => 3, hours => 1)     → 17 days 01:00:00


### Now Functions: clock vs statement vs transaction

PostgreSQL has *five* "current time" functions, with three different semantics:[^datetime-fns]

| Function | Returns | Semantics |
|---|---|---|
| `current_timestamp` / `now()` / `transaction_timestamp()` | `timestamptz` | Transaction start time. **Stable** within a transaction. |
| `statement_timestamp()` | `timestamptz` | Receipt of the latest command from the client. May differ from `now()` in subsequent statements. |
| `clock_timestamp()` | `timestamptz` | Actual current wall clock. **Volatile** — changes within a single SQL statement. |
| `current_date` | `date` | Date portion of `now()` |
| `current_time` | `timetz` | Time portion of `now()` (rarely useful — see warning above) |
| `localtimestamp` | `timestamp` | `now()` rendered in session zone but stripped of the zone marker |
| `localtime` | `time` | Time portion of `localtimestamp` |
| `timeofday()` | `text` | Like `clock_timestamp()` but as a formatted string. Legacy; prefer `clock_timestamp()`. |

From the docs:[^datetime-fns]

> *"Since these functions return the start time of the current transaction, their values do not change during the transaction. This is considered a feature: the intent is to allow a single transaction to have a consistent notion of the 'current' time, so that multiple modifications within the same transaction bear the same time stamp."*

Picking the right one:

- **Audit columns / version timestamps** — `now()`. All rows touched in one transaction get the same value; that's exactly what you want for "this batch happened atomically."
- **Microbenchmark inside one query** — `clock_timestamp() - clock_timestamp()` brackets to time individual sub-expressions or LATERAL operations.
- **Per-statement timing inside a long transaction** — `statement_timestamp()`. Useful when one transaction issues several batches and you want each batch's start time.

> [!WARNING] DEFAULT-clause hazard with `'now'`
> The string-literal forms (`'now'`, `'today'`, etc.) are *evaluated immediately when parsed*. The docs warn:[^datetime-fns] *"Do not use the third form when specifying a value to be evaluated later, for example in a `DEFAULT` clause for a table column. The system will convert `now` to a `timestamp` as soon as the constant is parsed, so that when the default value is needed, the time of the table creation would be used!"*
>
>     -- WRONG: every row gets the table's CREATE time, not the row's INSERT time
>     CREATE TABLE bad (created_at timestamptz DEFAULT 'now');
>
>     -- RIGHT: now() is a function call, evaluated per-INSERT
>     CREATE TABLE good (created_at timestamptz DEFAULT now());


### to_char, to_timestamp, to_date

Format conversion:[^formatting]

    to_char(timestamp '2002-04-20 17:31:12.66', 'HH12:MI:SS')   → '05:31:12'
    to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS')                    → '2026-05-11T08:30:00'
    to_char(now(), 'FMDay, FMMonth FMDD, YYYY')                  → 'Monday, May 11, 2026'
    to_char(interval '15h 2m 12s', 'HH24:MI:SS')                 → '15:02:12'

    to_date('05 Dec 2000', 'DD Mon YYYY')                        → 2000-12-05
    to_timestamp('05 Dec 2000 14:30', 'DD Mon YYYY HH24:MI')     → 2000-12-05 14:30:00-05

Common pattern letters (full table is in the formatting docs):

| Pattern | Meaning | Pattern | Meaning |
|---|---|---|---|
| `YYYY` | 4-digit year | `MI` | minute (00–59) |
| `MM` | month number (01–12) | `SS` | second (00–59) |
| `Mon` / `Month` | abbreviated / full month name | `MS` | millisecond (000–999) |
| `DD` | day of month (01–31) | `US` | microsecond (000000–999999) |
| `HH24` | hour 00–23 | `TZ` | tz abbreviation (`to_char` only) |
| `HH12` / `AM` / `PM` | 12-hour clock + meridiem | `OF` | offset from UTC (`to_char` only) |
| `DDD` | day of year (001–366) | `IW` | ISO week (01–53) |
| `D` | day of week (1=Sun … 7=Sat) | `IYYY` / `ID` | ISO year / ISO day-of-week (1=Mon) |

Modifier prefixes/suffixes: `FM` (suppress padding), `TM` (use `lc_time` localized names), `TH` / `th` (ordinal suffix), `FX` (fixed format — strict separator matching).

> [!NOTE] PostgreSQL 17
> `to_timestamp()` gained the `TZ` and `OF` time-zone format specifiers on input.[^pg17-tots] `TZ` accepts time zone abbreviations or numeric offsets; `OF` accepts only numeric offsets.

> [!NOTE] PostgreSQL 15
> `to_char()` added lowercase `of`, `tzh`, and `tzm` format codes.[^pg15-tochar]

> [!WARNING] `to_timestamp` / `to_date` `YYYY` quirk for years > 4 digits
> The verbatim docs:[^formatting] *"In `to_timestamp` and `to_date`, the `YYYY` conversion has a restriction when processing years with more than 4 digits. You must use some non-digit character or template after `YYYY`, otherwise the year is always interpreted as 4 digits."* So `to_date('200001130', 'YYYYMMDD')` parses `2000` as the year; use `to_date('20000-1130', 'YYYY-MMDD')` instead.

> [!WARNING] `to_timestamp` ignores letter case and skips spaces
> *"`to_timestamp` and `to_date` ignore letter case in the input; `MON`, `Mon`, and `mon` all accept the same strings."* Multiple blanks, weekday names, and quarter fields are accepted but ignored. If you need strict matching use the `FX` modifier.[^formatting]


### Special Values

The docs list a small catalog of accepted input strings that are not literal dates:[^datetime]

| Input | Valid for | Meaning |
|---|---|---|
| `epoch` | `date`, `timestamp[tz]` | 1970-01-01 00:00:00+00 (Unix time zero) |
| `infinity` | `date`, `timestamp[tz]` | Later than every other value |
| `-infinity` | `date`, `timestamp[tz]` | Earlier than every other value |
| `now` | `date`, `time`, `timestamp[tz]` | Current transaction start time |
| `today` | `date`, `timestamp[tz]` | Midnight today |
| `tomorrow` | `date`, `timestamp[tz]` | Midnight tomorrow |
| `yesterday` | `date`, `timestamp[tz]` | Midnight yesterday |
| `allballs` | `time` | 00:00:00.00 UTC |

The infinity sentinels are the practically useful members of this list. Use them as upper/lower bounds in business logic where the alternative would be a `NULL` + special-cased SQL.

    -- A subscription with no end date
    INSERT INTO subscriptions(user_id, started_at, expires_at)
    VALUES (42, now(), 'infinity');

    -- "Active subscriptions" needs no NULL handling
    SELECT * FROM subscriptions WHERE expires_at > now();

> [!NOTE] PostgreSQL 16
> `+infinity` (with explicit `+`) is now accepted spelling on input alongside `infinity`.[^pg16-infinity] Also: `epoch` and `infinity` can no longer be combined with other fields in datetime strings.[^pg16-infinity-restriction]

> [!WARNING] `'now'` / `'today'` are evaluation-time, not invocation-time
> The docs warn:[^datetime] *"While the input strings `now`, `today`, `tomorrow`, and `yesterday` are fine to use in interactive SQL commands, they can have surprising behavior when the command is saved to be executed later, for example in prepared statements, views, and function definitions. The string can be converted to a specific time value that continues to be used long after it becomes stale. Use one of the SQL functions instead in such contexts. For example, `CURRENT_DATE + 1` is safer than `'tomorrow'::date`."*


### TimeZone GUC and Time Zone Names

The session `TimeZone` GUC controls (a) interpretation of a `timestamptz` literal that lacks an explicit zone, and (b) rendering of every `timestamptz` value back to the client.[^datetime] The default is set by `initdb` from the OS locale; the built-in fallback is `GMT`.[^runtime-config]

PostgreSQL accepts three forms of zone name:[^datetime]

| Form | Example | DST-aware? |
|---|---|---|
| Full IANA name | `'America/New_York'` | Yes |
| Abbreviation | `'EST'`, `'PST'` | No (fixed offset; ignores DST) |
| POSIX | `'EST5EDT'` | Yes (POSIX rules) |

**Rule:** prefer the IANA full name. Abbreviations are ambiguous (`'IST'` is India, Ireland, *and* Israel) and most are not DST-aware.

    -- DST-aware: November 1 in 2026 is the day clocks go back
    SET TimeZone = 'America/New_York';
    SELECT '2026-11-01 01:30'::timestamptz;   -- ambiguous; PG picks the EDT (pre-fall-back) interpretation

    -- DST-blind: 'EST' is fixed at -05:00 always
    SET TimeZone = 'EST';
    SELECT '2026-07-04 12:00'::timestamptz;   -- 2026-07-04 12:00:00-05  (wrong for actual NYC; should be -04 in summer)

Inspect available zones:

    SELECT name, abbrev, utc_offset, is_dst FROM pg_timezone_names ORDER BY name;
    SELECT abbrev, utc_offset, is_dst FROM pg_timezone_abbrevs ORDER BY abbrev;

> [!NOTE] PostgreSQL 18
> Time zone abbreviation handling priority changed.[^pg18-tz] *"The system will now favor the current session's time zone abbreviations before checking the server variable `timezone_abbreviations`. Previously `timezone_abbreviations` was checked first."*


### DateStyle, IntervalStyle, Output Formats

Output rendering is controlled by `DateStyle` and `IntervalStyle` GUCs. Defaults are usually fine, but be aware they exist:[^datetime]

| `DateStyle` | Example output |
|---|---|
| `ISO` (default) | `1997-12-17 07:37:16-08` |
| `SQL` | `12/17/1997 07:37:16.00 PST` |
| `Postgres` | `Wed Dec 17 07:37:16 1997 PST` |
| `German` | `17.12.1997 07:37:16.00 PST` |

The first half of the value (`ISO` / `SQL` / `Postgres` / `German`) controls output. The second half (`MDY` / `DMY` / `YMD`) controls input ambiguity for dates like `'03/04/05'`.

| `IntervalStyle` | Example |
|---|---|
| `postgres` (default) | `1 year 2 mons 3 days 04:05:06` |
| `postgres_verbose` | `@ 1 year 2 mons 3 days 4 hours 5 mins 6 secs` |
| `sql_standard` | `1-2 +3 -4:05:06` (mixed units in SQL standard format) |
| `iso_8601` | `P1Y2M3DT4H5M6S` |

> [!NOTE] PostgreSQL 15
> The `interval` output function is now `STABLE` rather than `IMMUTABLE`, because it depends on `IntervalStyle`.[^pg15-interval-stable] *"This will, for example, cause creation of indexes relying on the text output of `interval` values to fail."* If you had an expression index on `'now()'::text` or similar, that index will need rebuilding with a different expression after upgrade.


## Examples / Recipes


### 1. Always-timestamptz table (the canonical default)

    CREATE TABLE events (
        id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),  -- microsecond-precision wall clock
        user_id     bigint      NOT NULL,
        payload     jsonb       NOT NULL
    );

    CREATE INDEX events_occurred_at_idx ON events (occurred_at DESC);
    CREATE INDEX events_user_occurred_idx ON events (user_id, occurred_at DESC);

`occurred_at` defaults to `now()` (transaction start, stable across multiple inserts in one batch). `recorded_at` defaults to `clock_timestamp()` (true wall clock at the per-row evaluation, useful for ordering rows inserted in a single transaction).


### 2. Audit query: find every `timestamp without time zone` column

Run this on any database before sign-off. Almost all hits are bugs.

    SELECT
        n.nspname  AS schema,
        c.relname  AS table_name,
        a.attname  AS column_name,
        format_type(a.atttypid, a.atttypmod) AS column_type
    FROM   pg_attribute a
    JOIN   pg_class     c ON c.oid = a.attrelid
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   pg_type      t ON t.oid = a.atttypid
    WHERE  c.relkind IN ('r', 'p')          -- ordinary + partitioned tables
      AND  a.attnum > 0
      AND  NOT a.attisdropped
      AND  n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND  t.typname IN ('timestamp', 'timetz')
    ORDER BY 1, 2, 3;


### 3. Migrate `timestamp` to `timestamptz` (pick a zone interpretation)

    -- The zone you pass to AT TIME ZONE is the zone the existing values were *recorded in*.
    -- If your application always wrote UTC, pass 'UTC'. If it wrote local time in NY, pass 'America/New_York'.

    BEGIN;
    ALTER TABLE events
        ALTER COLUMN occurred_at TYPE timestamptz
        USING occurred_at AT TIME ZONE 'UTC';
    COMMIT;

This rewrites the table (full ACCESS EXCLUSIVE lock; unsuitable for hot tables in one shot — see [`01-syntax-ddl.md`](./01-syntax-ddl.md) for the dual-column shadow pattern). Test the `USING` clause on a representative subset first.


### 4. Bucketed analytics with `date_trunc` (matched by an expression index)

    -- Hourly event counts in user's local zone
    SELECT date_trunc('hour', occurred_at, 'America/New_York') AS hour,
           count(*)
    FROM   events
    WHERE  occurred_at >= now() - interval '7 days'
    GROUP  BY 1
    ORDER  BY 1;

    -- Functional index covering the bucketed expression (PG16+ — date_trunc/3 is IMMUTABLE)
    CREATE INDEX events_hour_ny_idx
        ON events (date_trunc('hour', occurred_at, 'America/New_York'));

For pre-PG16 you cannot index `date_trunc(text, timestamptz, text)` because the 3-arg form was `STABLE`. Workaround: store the bucketed value in a generated column (`STORED`) and index that.


### 5. Bucketed analytics with `date_bin` (custom-stride windows)

`date_bin` solves "I need 5-minute buckets aligned to the hour":

    SELECT date_bin('5 minutes', occurred_at, TIMESTAMPTZ '2000-01-01') AS bucket,
           count(*)
    FROM   events
    WHERE  occurred_at >= now() - interval '1 day'
    GROUP  BY 1
    ORDER  BY 1;

`date_bin` cannot use month-or-larger strides because their length varies; for monthly buckets use `date_trunc('month', ...)`.


### 6. Ranges of bucketed timestamps with `generate_series`

Generate a continuous time-series spine to LEFT JOIN against your event counts so empty buckets show up as zero:

    WITH spine AS (
        SELECT generate_series(
            date_trunc('hour', now() - interval '24 hours'),
            date_trunc('hour', now()),
            interval '1 hour'
        ) AS hour
    )
    SELECT s.hour,
           COALESCE(count(e.id), 0) AS events
    FROM   spine s
    LEFT JOIN events e
           ON e.occurred_at >= s.hour
          AND e.occurred_at <  s.hour + interval '1 hour'
    GROUP  BY s.hour
    ORDER  BY s.hour;


### 7. Open-ended expiry with `'infinity'` (no NULL gymnastics)

    CREATE TABLE memberships (
        user_id     bigint     PRIMARY KEY,
        plan        text       NOT NULL,
        started_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL DEFAULT 'infinity'
    );

    -- "Active members" — no special handling for unbounded
    SELECT user_id FROM memberships WHERE expires_at > now();

    -- Setting an expiry later
    UPDATE memberships SET expires_at = now() + interval '30 days' WHERE user_id = 42;

    -- Removing an expiry
    UPDATE memberships SET expires_at = 'infinity' WHERE user_id = 42;


### 8. DST-aware "1 day later" vs DST-blind "24 hours later"

    SET TimeZone = 'America/New_York';

    -- Scheduling user-visible "every day at 12pm local" — wall clock semantics
    SELECT next_run + interval '1 day' AS next_run FROM jobs;       -- skips 23 or 25h on DST days; correct for human-facing "daily at noon"

    -- Wallclock-stable "exactly 24 hours later" — instant semantics
    SELECT next_run + interval '24 hours' AS next_run FROM jobs;    -- always 24h forward; user sees 11am or 1pm on DST days

The choice is yours; pick deliberately.


### 9. Convert a unix epoch (seconds) to timestamptz

    SELECT to_timestamp(1714435200);   -- 2024-04-30 00:00:00+00

`to_timestamp(double precision)` returns `timestamptz`. The fractional part is sub-second resolution.

Reverse direction:

    SELECT EXTRACT(epoch FROM TIMESTAMPTZ '2024-04-30 00:00:00+00');   -- 1714435200

> [!WARNING] `to_timestamp` on epoch from a naive `timestamp` is misleading
> The docs warn:[^datetime-fns] *"Beware that applying `to_timestamp` to an epoch extracted from a `date` or `timestamp` value could produce a misleading result: the result will effectively assume that the original value had been given in UTC, which might not be the case."*


### 10. Per-row event ordering inside a single transaction with `clock_timestamp()`

    BEGIN;
    INSERT INTO events(occurred_at, recorded_at, ...) VALUES (now(), clock_timestamp(), ...);
    INSERT INTO events(occurred_at, recorded_at, ...) VALUES (now(), clock_timestamp(), ...);
    INSERT INTO events(occurred_at, recorded_at, ...) VALUES (now(), clock_timestamp(), ...);
    COMMIT;

All three rows have the same `occurred_at` (transaction start). Each has a different `recorded_at` (per-statement wall clock), so `ORDER BY recorded_at` reproduces insertion order even within one transaction.


### 11. Format Postgres timestamps as ISO 8601 strings

    SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
    --   2026-05-11T08:30:00Z

Or use the SQL-standard form via casting:

    SELECT now()::text;
    --   2026-05-11 08:30:00.123456-05  (uses DateStyle, may not be ISO-8601-strict)


### 12. Round-trip a JSON timestamp string back into timestamptz

    SELECT '2026-05-11T08:30:00Z'::timestamptz;
    --   2026-05-11 03:30:00-05  (ISO 8601 input is always accepted; rendered in session zone)

PostgreSQL accepts both `T` and space as the date-time separator on input, but always emits a space on output.[^datetime]


### 13. Find rows that fall in user-local "today"

    SELECT * FROM events
    WHERE occurred_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
      AND occurred_at <  date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' + interval '1 day';

The two `AT TIME ZONE` calls together: first strips the zone (giving the user's local wall clock), then re-anchors to that zone (giving a UTC instant for the user-local midnight).

PG17+ short form using `AT LOCAL` (when the session `TimeZone` is already `America/New_York`):

    SET TimeZone = 'America/New_York';

    SELECT * FROM events
    WHERE occurred_at >= date_trunc('day', now() AT LOCAL) AT LOCAL
      AND occurred_at <  date_trunc('day', now() AT LOCAL) AT LOCAL + interval '1 day';


### 14. Detect rows in DST-spring-forward "missing hour"

    -- US Eastern spring-forward 2026-03-08: clock jumped from 02:00 to 03:00
    -- A wall-clock value of '2026-03-08 02:30' in NY does not represent any real instant
    SELECT '2026-03-08 02:30'::timestamp AT TIME ZONE 'America/New_York';
    -- Result: 2026-03-08 07:30:00+00  (PG silently maps to 03:30 EDT)

    -- Inverse: fall-back has the *opposite* problem (one wall-clock hour happens twice)
    -- 2026-11-01 01:30 EDT and 01:30 EST are different instants — PG picks one without warning


### 15. Year/month/day arithmetic — pick the right operator

    -- Add 1 month to last day of February — what do you get?
    SELECT '2026-02-28'::date + interval '1 month';     -- 2026-03-28 00:00:00
    SELECT '2026-01-31'::date + interval '1 month';     -- 2026-02-28 00:00:00  (clamped to month length)
    SELECT '2026-01-31'::date + interval '30 days';     -- 2026-03-02 00:00:00  (no clamp)

    -- Last-day-of-month idiom
    SELECT (date_trunc('month', d) + interval '1 month - 1 day')::date AS last_day_of_month
    FROM   (VALUES ('2026-02-15'::date)) v(d);
    --   2026-02-28


### 16. Range-friendly "current period" using tstzrange

    CREATE TABLE billing_periods (
        user_id   bigint NOT NULL,
        period    tstzrange NOT NULL,
        amount    numeric(12, 2) NOT NULL,
        EXCLUDE USING gist (user_id WITH =, period WITH &&)   -- needs btree_gist for the `=` operator
    );

    -- Insert a monthly billing period in user-local terms
    INSERT INTO billing_periods(user_id, period, amount)
    VALUES (42,
            tstzrange(date_trunc('month', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York',
                      (date_trunc('month', now() AT TIME ZONE 'America/New_York') + interval '1 month') AT TIME ZONE 'America/New_York',
                      '[)'),
            29.99);

Cross-reference [`15-data-types-custom.md`](./15-data-types-custom.md) for the full range/multirange + EXCLUDE USING gist deep dive.


## Gotchas / Anti-patterns


### 1. Storing application timestamps as `timestamp without time zone`

The single most common bug. The naïve type loses zone information; reads from sessions with different `TimeZone` settings see different values for "the same" stored row. **Audit recipe 2 above; migrate with recipe 3.**


### 2. `timestamptz` does *not* store a time zone

See Mental Model rule 2. If you need to remember the originating zone (e.g., to render to a user the local time at the recording site), store the zone in a separate `text` column.[^datetime]


### 3. `'1 month' = '30 days'` is **false**

The interval months/days/microseconds-as-three-fields rule.[^datetime] All of these are different values:

    SELECT interval '1 month' = interval '30 days';   -- false
    SELECT interval '1 day'   = interval '24 hours';  -- false (under DST-relevant addition)


### 4. Adding `interval '1 day'` is not the same as adding `'24 hours'`

DST. `'1 day'` walks the calendar (wall-clock semantics); `'24 hours'` walks the instant (microsecond semantics). On spring-forward day a `'1 day'` add advances 23 hours; on fall-back day it advances 25 hours.


### 5. Using `'now'`, `'today'`, etc. in DEFAULT clauses, views, or function bodies

These string literals are evaluated when the *DDL* is parsed, freezing the value forever.[^datetime-fns] **Always use `now()` (function call), `current_timestamp` (special variable), or `current_date + 1` instead of `'tomorrow'::date`.**

    -- WRONG: every row gets the table-create time
    CREATE TABLE bad (created_at timestamptz DEFAULT 'now');

    -- RIGHT: function call evaluated per INSERT
    CREATE TABLE good (created_at timestamptz DEFAULT now());


### 6. `now()` does not change inside a transaction

See Mental Model rule 4. If you need wall-clock granularity (per-row INSERT order, per-statement timing), use `clock_timestamp()` or `statement_timestamp()` accordingly.


### 7. `time with time zone` cannot tell you whether DST applies

Without a date, no DST decision is possible.[^datetime] `time with time zone` is supported but the docs explicitly recommend against it. Use `timestamptz` (which carries date) or `time without time zone` (which doesn't pretend to know the zone).


### 8. DST spring-forward maps a non-existent wall-clock to a real instant silently

`'2026-03-08 02:30'::timestamp AT TIME ZONE 'America/New_York'` doesn't error. Postgres maps it to the post-jump interpretation (`03:30 EDT`). If your application accepts user-input wall-clock during the missing hour, you get a value that doesn't correspond to what the user intended without any warning.


### 9. DST fall-back maps an ambiguous wall-clock to one of two instants without indication

The opposite problem: `'2026-11-01 01:30'` in NYC happens twice (once at 01:30 EDT, once at 01:30 EST). Postgres picks one. There is no `is_ambiguous` flag. For applications that take wall-clock input during DST transitions, capture the offset explicitly: `'2026-11-01 01:30-04'` vs `'2026-11-01 01:30-05'`.


### 10. Time zone abbreviations are not DST-aware (and are ambiguous across regions)

`SET TimeZone = 'EST'` fixes the offset at -05:00 forever; it never observes DST. `'IST'` means three different zones depending on context. **Always use IANA full names like `'America/New_York'`** unless you are explicitly testing a fixed-offset behavior.


### 11. The `to_timestamp` `YYYY` 4-digit limit

`to_timestamp('20000130', 'YYYYMMDD')` parses year `2000` and gets the rest mangled.[^formatting] Use a non-digit separator: `to_timestamp('20000-1-30', 'YYYY-MM-DD')`. Same applies to `to_date`.


### 12. `to_timestamp` ignores letter case and whitespace

`to_timestamp('5 dec 2000', 'DD MON YYYY')` parses just fine; so does `to_timestamp('5     Dec    2000', 'DD MON YYYY')`. If you need strict matching, prefix the format with `FX`: `to_timestamp('05 Dec 2000', 'FXDD Mon YYYY')`.[^formatting]


### 13. `EXTRACT(epoch ...)` from naïve `timestamp` is interpreted as UTC

`EXTRACT(epoch FROM timestamp '2026-05-11 12:00')` returns the seconds since epoch *as if the input were UTC*, regardless of session zone. If your `timestamp` column contains values in some local zone, convert first: `EXTRACT(epoch FROM (timestamp '...' AT TIME ZONE 'America/New_York'))`.


### 14. Storing dates as `text` (`'2026-05-11'`) instead of `date`

You lose: range queries, indexing semantics, arithmetic, comparison, validation. Cast to `date` at the schema level. Audit candidates: any `text`/`varchar` column whose name ends in `_date`/`_at`/`_time`/`_on`.


### 15. Storing intervals as integer seconds

You lose: month/year semantics (`age()`, `+ interval '1 month'`), the human-readable `IntervalStyle` output, and the calendar-aware `'1 day'` vs `'24 hours'` distinction. Use `interval` for durations.


### 16. Indexing `now()` or `current_date` in a function-marked `IMMUTABLE`

These are `STABLE`, not `IMMUTABLE`. Marking a function `IMMUTABLE` and calling `now()` inside is a lie — the planner may evaluate at plan time and cache the result indefinitely. See [`06-functions.md`](./06-functions.md) for volatility rules.


### 17. Cross-zone comparisons of `timestamp` (without zone)

`timestamp '2026-05-11 12:00' < timestamp '2026-05-11 13:00'` works numerically, but if those two values were recorded by users in different zones the comparison is meaningless. **Don't do cross-user time math on naïve timestamps.** Use `timestamptz`.


### 18. `'tomorrow'::date` in a CHECK constraint

CHECK constraints are evaluated at INSERT/UPDATE time, but the *literal* `'tomorrow'` is parsed when the constraint is *defined*, freezing it at table-create time. Use `current_date + 1` instead — that's a function call evaluated at row-write time.


### 19. `justify_*` functions silently change values

`justify_hours('48 hours')` returns `'2 days'`. Adding `'48 hours'` to a timestamptz across a DST boundary moves you 48h; adding `'2 days'` moves you 47 or 49h depending on the direction. Never `justify_*` a value before storing it for arithmetic later.


### 20. `current_time` without `_timestamp` is almost never what you want

`current_time` returns `time with time zone`, which the docs themselves recommend against. Use `current_timestamp` (full timestamptz) or `localtime` (zone-stripped time-of-day) depending on intent.


## See Also

- [`01-syntax-ddl.md`](./01-syntax-ddl.md) — `ALTER TABLE ALTER COLUMN TYPE` mechanics for the timestamp→timestamptz migration
- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — broader scalar type matrix; `timestamptz` placement in the type-selection guide
- [`15-data-types-custom.md`](./15-data-types-custom.md) — `tstzrange` / `tsrange`, `EXCLUDE USING gist (... && ...)` for non-overlapping time windows, multirange (PG14+)
- [`06-functions.md`](./06-functions.md) — `IMMUTABLE` / `STABLE` / `VOLATILE` semantics; why marking `now()` as immutable breaks plans
- [`08-plpgsql.md`](./08-plpgsql.md) — using `clock_timestamp()` to time loop iterations
- [`35-partitioning.md`](./35-partitioning.md) — RANGE partitioning by `occurred_at`, partition-key-aware queries
- [`56-explain.md`](./56-explain.md) — reading EXPLAIN output for time-bucket aggregations and verifying expression-index usage
- [`65-collations-encoding.md`](./65-collations-encoding.md) — `lc_time` (used by `to_char`'s `TM` modifier) and locale handling
- [`98-pg-cron.md`](./98-pg-cron.md) — scheduling jobs that depend on session zone semantics
- [`18-uuid-numeric-money.md`](./18-uuid-numeric-money.md) — UUIDv7 `uuid_extract_timestamp()` for deriving `timestamptz` from a UUID primary key


## Sources

[^datetime]: PostgreSQL 16 documentation — Date/Time Types. *"`timestamptz` is accepted as an abbreviation for `timestamp with time zone`; this is a PostgreSQL extension."* / *"In a value that has been determined to be `timestamp without time zone`, PostgreSQL will silently ignore any time zone indication."* / *"For `timestamp with time zone` values, an input string that includes an explicit time zone will be converted to UTC."* / *"When a `timestamp with time zone` value is output, it is always converted from UTC to the current `timezone` zone, and displayed as local time in that zone."* / *"Internally, `interval` values are stored as three integral fields: months, days, and microseconds. These fields are kept separate because the number of days in a month varies, while a day can have 23 or 25 hours if a daylight savings time transition is involved."* / *"we recommend using date/time types that contain both date and time when using time zones. We do not recommend using the type `time with time zone`."* / Special-value table including `epoch`, `infinity`, `-infinity`, `now`, `today`, `tomorrow`, `yesterday`, `allballs`. https://www.postgresql.org/docs/16/datatype-datetime.html
[^datetime-fns]: PostgreSQL 16 documentation — Date/Time Functions and Operators. AT TIME ZONE asymmetric signatures and behavior. `date_trunc`, `date_part`, `EXTRACT`, `date_bin`, `age`, `justify_*`, `make_*`, `to_timestamp`, `current_*`, `now`, `transaction_timestamp`, `statement_timestamp`, `clock_timestamp`, `timeofday` signatures and descriptions. *"Since these functions return the start time of the current transaction, their values do not change during the transaction. This is considered a feature."* / *"Do not use the third form when specifying a value to be evaluated later, for example in a `DEFAULT` clause for a table column. The system will convert `now` to a `timestamp` as soon as the constant is parsed, so that when the default value is needed, the time of the table creation would be used!"* / *"For historical reasons, the `date_part` function returns values of type `double precision`. This can result in a loss of precision in certain uses. Using `extract` is recommended instead."* / *"Beware that applying `to_timestamp` to an epoch extracted from a `date` or `timestamp` value could produce a misleading result: the result will effectively assume that the original value had been given in UTC, which might not be the case."* https://www.postgresql.org/docs/16/functions-datetime.html
[^formatting]: PostgreSQL 16 documentation — Data Type Formatting Functions (Section 9.8). `to_char` / `to_timestamp` / `to_date` signatures, full pattern table (HH/HH12/HH24/MI/SS/MS/US/FF1-6/SSSS/Y/YY/YYY/YYYY/IYYY/MM/Mon/Month/DD/D/DOY/IDDD/W/WW/IW/CC/J/Q/RM/TZ/TZH/TZM/OF/AM/PM/BC/AD), modifiers (FM, TH, FX, TM, SP). *"In `to_timestamp` and `to_date`, the `YYYY` conversion has a restriction when processing years with more than 4 digits. You must use some non-digit character or template after `YYYY`, otherwise the year is always interpreted as 4 digits."* / *"`to_timestamp` and `to_date` ignore letter case in the input; `MON`, `Mon`, and `mon` all accept the same strings."* https://www.postgresql.org/docs/16/functions-formatting.html
[^runtime-config]: PostgreSQL 16 documentation — Server configuration: `TimeZone` and `timezone_abbreviations`. *"Sets the time zone for displaying and interpreting time stamps. The built-in default is GMT, but that is typically overridden in postgresql.conf; initdb will install a setting there corresponding to its system environment."* / *"Sets the collection of time zone abbreviations that will be accepted by the server for datetime input. The default is 'Default', which is a collection that works in most of the world."* https://www.postgresql.org/docs/16/runtime-config-client.html
[^pg14-datebin]: PostgreSQL 14 release notes — *"Add `date_bin()` function (John Naylor). This function 'bins' input timestamps, grouping them into intervals of a uniform length aligned with a specified origin."* https://www.postgresql.org/docs/release/14.0/
[^pg14-extract]: PostgreSQL 14 release notes — *"Change `EXTRACT()` to return type `numeric` instead of `float8` (Peter Eisentraut). This avoids loss-of-precision issues in some usages. The old behavior can still be obtained by using the old underlying function `date_part()`. Also, `EXTRACT(date)` now throws an error for units that are not part of the `date` data type."* https://www.postgresql.org/docs/release/14.0/
[^pg14-makets]: PostgreSQL 14 release notes — *"Allow `make_timestamp()` / `make_timestamptz()` to accept negative years (Peter Eisentraut). Negative values are interpreted as BC years."* https://www.postgresql.org/docs/release/14.0/
[^pg15-interval]: PostgreSQL 15 release notes — *"When `interval` input provides a fractional value for a unit greater than months, round to the nearest month (Bruce Momjian). For example, convert `1.99 years` to `2 years`, not `1 year 11 months` as before."* https://www.postgresql.org/docs/release/15.0/
[^pg15-interval-stable]: PostgreSQL 15 release notes — *"Mark the `interval` output function as stable, not immutable, since it depends on `IntervalStyle` (Tom Lane). This will, for example, cause creation of indexes relying on the text output of `interval` values to fail."* https://www.postgresql.org/docs/release/15.0/
[^pg15-tochar]: PostgreSQL 15 release notes — *"Add `to_char()` format codes `of`, `tzh`, and `tzm` (Nitin Jadhav). The upper-case equivalents of these were already supported."* https://www.postgresql.org/docs/release/15.0/
[^pg16-trunc]: PostgreSQL 16 release notes — *"Change `date_trunc(unit, timestamptz, time_zone)` to be an immutable function (Przemyslaw Sztoch). This allows the creation of expression indexes using this function."* https://www.postgresql.org/docs/release/16.0/
[^pg16-infinity]: PostgreSQL 16 release notes — *"Accept the spelling `+infinity` in datetime input (Vik Fearing)."* https://www.postgresql.org/docs/release/16.0/
[^pg16-infinity-restriction]: PostgreSQL 16 release notes — *"Prevent the specification of `epoch` and `infinity` together with other fields in datetime strings (Joseph Koshakow)."* https://www.postgresql.org/docs/release/16.0/
[^pg17-atlocal]: PostgreSQL 17 release notes — *"Allow the session time zone to be specified by `AT LOCAL` (Vik Fearing). This is useful when converting adding and removing time zones from time stamps values, rather than specifying the literal session time zone."* https://www.postgresql.org/docs/release/17.0/
[^pg17-atlocal-docs]: PostgreSQL 17 documentation — Date/Time Functions and Operators, AT TIME ZONE / AT LOCAL section. *"The syntax `AT LOCAL` may be used as shorthand for `AT TIME ZONE local`, where `local` is the session's `TimeZone` value."* https://www.postgresql.org/docs/17/functions-datetime.html
[^pg17-interval]: PostgreSQL 17 release notes — *"Allow the `interval` data type to support `+/-infinity` values (Joseph Koshakow, Jian He, Ashutosh Bapat)."* https://www.postgresql.org/docs/release/17.0/
[^pg17-ago]: PostgreSQL 17 release notes — *"Restrict `ago` to only appear at the end in `interval` values (Joseph Koshakow). Also, prevent empty interval units from appearing multiple times."* https://www.postgresql.org/docs/release/17.0/
[^pg17-tots]: PostgreSQL 17 release notes — *"Add `to_timestamp()` time zone format specifiers (Tom Lane). `TZ` accepts time zone abbreviations or numeric offsets, while `OF` accepts only numeric offsets."* https://www.postgresql.org/docs/release/17.0/
[^pg18-extract]: PostgreSQL 18 release notes — *"Add a `WEEK` option to `EXTRACT()` (Tom Lane)."* and *"Improve the output `EXTRACT(QUARTER ...)` for negative values (Tom Lane)."* https://www.postgresql.org/docs/release/18.0/
[^pg18-tz]: PostgreSQL 18 release notes — *"Change time zone abbreviation handling (Tom Lane). The system will now favor the current session's time zone abbreviations before checking the server variable `timezone_abbreviations`. Previously `timezone_abbreviations` was checked first."* https://www.postgresql.org/docs/release/18.0/

# 24 — String, Date, and Math Functions

## Table of Contents

1. [When to Use This Reference](#when-to-use)
2. [String Functions](#string-functions)
   - [Concatenation](#concatenation)
   - [Searching and Position](#searching-and-position)
   - [Extraction and Transformation](#extraction-and-transformation)
   - [Trimming and Padding](#trimming-and-padding)
   - [Splitting](#splitting)
   - [Aggregation](#aggregation)
   - [Encoding / Hashing](#encoding--hashing)
3. [Date and Time Functions](#date-and-time-functions)
   - [Getting the Current Moment](#getting-the-current-moment)
   - [Date Parts and Arithmetic](#date-parts-and-arithmetic)
   - [Construction and Parsing](#construction-and-parsing)
   - [AT TIME ZONE](#at-time-zone)
   - [datetime vs datetime2 vs datetimeoffset](#datetime-vs-datetime2-vs-datetimeoffset)
   - [Common Date Patterns](#common-date-patterns)
4. [Math and Numeric Functions](#math-and-numeric-functions)
5. [Type Conversion Functions](#type-conversion-functions)
6. [FORMAT Function](#format-function)
7. [CHOOSE and IIF](#choose-and-iif)
8. [Gotchas / Anti-patterns](#gotchas--anti-patterns)
9. [See Also](#see-also)
10. [Sources](#sources)

---

## When to Use

Load this file when the user asks about:
- String manipulation (CONCAT, SUBSTRING, REPLACE, TRIM, CHARINDEX, PATINDEX, STRING_SPLIT, STRING_AGG, STUFF)
- Date/time math (DATEADD, DATEDIFF, EOMONTH, AT TIME ZONE, datetime type choices)
- Numeric functions (ROUND, FLOOR, CEILING, ABS, POWER, SQRT, RAND, LOG)
- Type conversion (CAST, CONVERT, TRY_CAST, TRY_CONVERT, PARSE, TRY_PARSE)
- FORMAT, CHOOSE, IIF

---

## String Functions

### Concatenation

```sql
-- + operator: returns NULL if any operand is NULL
SELECT 'Hello' + ' ' + 'World';        -- 'Hello World'
SELECT 'Hello' + NULL;                 -- NULL  ← common bug

-- CONCAT: ignores NULL, implicit NVARCHAR cast
SELECT CONCAT('Hello', ' ', 'World'); -- 'Hello World'
SELECT CONCAT('Hello', NULL, '!');    -- 'Hello!'

-- CONCAT_WS (with separator, 2017+): skips NULL args, does NOT skip empty string
SELECT CONCAT_WS(', ', 'Alice', NULL, 'Bob');  -- 'Alice, Bob'
SELECT CONCAT_WS(', ', 'Alice', '', 'Bob');    -- 'Alice, , Bob'

-- For building comma-separated lists from rows, use STRING_AGG — see Aggregation section
```

> [!NOTE] SQL Server 2017
> `CONCAT_WS` is new in SQL Server 2017. Use `STUFF` + `FOR XML PATH` on earlier versions.

### Searching and Position

```sql
-- CHARINDEX: returns 1-based position, 0 if not found
SELECT CHARINDEX('lo', 'Hello World');         -- 4
SELECT CHARINDEX('lo', 'Hello World', 5);      -- 0 (start search at pos 5)
-- NULL input returns NULL (unlike LIKE which treats NULL differently in predicates)

-- PATINDEX: like CHARINDEX but accepts LIKE patterns; 0 if not found
SELECT PATINDEX('%[0-9]%', 'abc123');          -- 4
SELECT PATINDEX('%[^a-z]%', 'abcDEF');         -- 4 (first non-lowercase)

-- LIKE operator (predicate, not a function)
WHERE col LIKE '%foo%'              -- contains 'foo'
WHERE col LIKE 'foo[_]bar'          -- literal underscore
WHERE col LIKE '[0-9][0-9][0-9]'   -- exactly 3 digits

-- ⚠ CHARINDEX / PATINDEX are not sargable — avoid in WHERE on large tables
-- Use a full-text index or computed+indexed column instead
```

### Extraction and Transformation

```sql
-- SUBSTRING(string, start, length) — 1-based start
SELECT SUBSTRING('Hello World', 7, 5);  -- 'World'
SELECT SUBSTRING('Hello', 3, 100);      -- 'llo' (no error past end)

-- LEFT / RIGHT
SELECT LEFT('Hello', 3);   -- 'Hel'
SELECT RIGHT('Hello', 3);  -- 'llo'

-- LEN: character count, excludes trailing spaces
-- DATALENGTH: byte count including trailing spaces
SELECT LEN('Hello  ');        -- 5 (trailing spaces stripped)
SELECT DATALENGTH('Hello  '); -- 7 (2 trailing spaces counted)
-- For NVARCHAR: DATALENGTH = 2 × character count

-- REPLACE(string, old, new) — case-insensitive per database collation
SELECT REPLACE('Hello World', 'World', 'SQL');  -- 'Hello SQL'
-- Replace all spaces:
SELECT REPLACE('Hello World', ' ', '_');        -- 'Hello_World'

-- STUFF(string, start, length, replacement) — splice
SELECT STUFF('Hello World', 6, 6, ' SQL');  -- 'HelloSQL'  ← replaces ' World'
-- Classic use: remove leading comma from dynamic list:
SELECT STUFF(',Alice,Bob,Carol', 1, 1, '');  -- 'Alice,Bob,Carol'

-- UPPER / LOWER
SELECT UPPER('hello');  -- 'HELLO'
SELECT LOWER('HELLO');  -- 'hello'

-- REVERSE
SELECT REVERSE('Hello');  -- 'olleH'

-- REPLICATE
SELECT REPLICATE('ab', 3);  -- 'ababab'

-- SPACE(n)
SELECT 'Hello' + SPACE(3) + 'World';  -- 'Hello   World'

-- STRING_ESCAPE (2016+): escapes special chars for JSON or URL
SELECT STRING_ESCAPE('tab:' + CHAR(9) + ' newline:' + CHAR(10), 'json');
-- '\"tab:\\t newline:\\n\"'
```

> [!NOTE] SQL Server 2016
> `STRING_ESCAPE` is new in SQL Server 2016.

### Trimming and Padding

```sql
-- Legacy (pre-2017): LTRIM / RTRIM — removes spaces only
SELECT LTRIM('  Hello  ');   -- 'Hello  '
SELECT RTRIM('  Hello  ');   -- '  Hello'
SELECT LTRIM(RTRIM('  Hello  '));  -- 'Hello'

-- Modern (2017+): TRIM — removes spaces AND optional characters from both ends
SELECT TRIM('  Hello  ');             -- 'Hello'
SELECT TRIM('.' FROM '...Hello...');  -- 'Hello'
SELECT TRIM('ab' FROM 'aabHellobb'); -- 'Hello'  ← strips any listed chars, any order

-- ⚠ TRIM strips individual characters, not a prefix/suffix string
SELECT TRIM('ab' FROM 'baHello');  -- 'Hello'  (strips b, then a from start)
SELECT TRIM('ab' FROM 'acHello');  -- 'cHello' (only strips 'a'; 'c' stops it)

-- Padding: no built-in LPAD/RPAD; use REPLICATE + RIGHT/LEFT
-- Right-pad 'Hi' to 10 chars with spaces:
SELECT LEFT('Hi' + REPLICATE(' ', 10), 10);   -- 'Hi        '
-- Left-pad number to 6 digits with zeros:
SELECT RIGHT(REPLICATE('0', 6) + CAST(42 AS VARCHAR), 6);  -- '000042'
-- Cleaner with FORMAT:
SELECT FORMAT(42, 'D6');  -- '000042'  (but FORMAT is slow — see FORMAT section)
```

> [!NOTE] SQL Server 2017
> Enhanced `TRIM` with character-set stripping is new in SQL Server 2017. On 2016 and earlier use `LTRIM(RTRIM(...))`.

### Splitting

```sql
-- STRING_SPLIT (2016+): splits a string by delimiter, returns single-value table
SELECT value FROM STRING_SPLIT('Alice,Bob,Carol', ',');
-- value
-- -----
-- Alice
-- Bob
-- Carol

-- With ordinal (2022+): preserves original position
SELECT ordinal, value
FROM STRING_SPLIT('Alice,Bob,Carol', ',', 1);
-- ordinal  value
-- -------  -----
-- 1        Alice
-- 2        Bob
-- 3        Carol

-- Join split values back to a table:
SELECT e.EmployeeId, s.value AS Tag
FROM dbo.Employees e
CROSS APPLY STRING_SPLIT(e.TagList, ',') s;

-- ⚠ Before 2022, STRING_SPLIT output order is not guaranteed
-- Use WITH ORDINAL (3rd arg = 1) in 2022+ when order matters
```

> [!NOTE] SQL Server 2016
> `STRING_SPLIT` is new in SQL Server 2016.

> [!NOTE] SQL Server 2022
> The `ordinal` output column (and third argument `enable_ordinal`) is new in SQL Server 2022.

### Aggregation

```sql
-- STRING_AGG (2017+): aggregate rows into a delimited string
SELECT STRING_AGG(Name, ', ') AS Names
FROM dbo.Employees;

-- With WITHIN GROUP ORDER BY:
SELECT STRING_AGG(Name, ', ') WITHIN GROUP (ORDER BY Name ASC) AS SortedNames
FROM dbo.Employees;

-- Grouped:
SELECT DepartmentId,
       STRING_AGG(Name, '; ') WITHIN GROUP (ORDER BY HireDate) AS TeamRoster
FROM dbo.Employees
GROUP BY DepartmentId;

-- ⚠ STRING_AGG returns NULL when all inputs are NULL
-- ⚠ Max output size is NVARCHAR(MAX) — no 4000-char truncation like JSON_VALUE
-- ⚠ On pre-2017: use STUFF + FOR XML PATH pattern:
SELECT STUFF(
  (SELECT ',' + Name
   FROM dbo.Employees
   WHERE DepartmentId = d.DepartmentId
   ORDER BY HireDate
   FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
  1, 1, '')
FROM dbo.Departments d;
```

> [!NOTE] SQL Server 2017
> `STRING_AGG` is new in SQL Server 2017.

### Encoding / Hashing

```sql
-- ASCII / CHAR / UNICODE / NCHAR
SELECT ASCII('A');          -- 65
SELECT CHAR(65);            -- 'A'
SELECT UNICODE(N'€');       -- 8364
SELECT NCHAR(8364);         -- N'€'

-- HASHBYTES: returns varbinary; algorithm options: MD5, SHA1, SHA2_256, SHA2_512
-- ⚠ MD5 and SHA1 are cryptographically broken — use SHA2_256 or SHA2_512
SELECT HASHBYTES('SHA2_256', N'Hello World');  -- varbinary(32)
-- Convert to hex string for display:
SELECT CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', N'Hello World'), 2);

-- COMPRESS / DECOMPRESS (2016+): gzip-compatible byte compression
DECLARE @compressed VARBINARY(MAX) = COMPRESS(N'Hello World repeated...');
DECLARE @text NVARCHAR(MAX) = CAST(DECOMPRESS(@compressed) AS NVARCHAR(MAX));
```

> [!NOTE] SQL Server 2016
> `COMPRESS` / `DECOMPRESS` are new in SQL Server 2016.

---

## Date and Time Functions

### Getting the Current Moment

| Function | Return Type | Precision | Notes |
|---|---|---|---|
| `GETDATE()` | `datetime` | ~3.33 ms | Legacy; prefers deterministic replacement |
| `CURRENT_TIMESTAMP` | `datetime` | ~3.33 ms | ANSI SQL synonym for GETDATE() |
| `SYSDATETIME()` | `datetime2(7)` | 100 ns | Preferred for new code |
| `SYSDATETIMEOFFSET()` | `datetimeoffset(7)` | 100 ns | Includes UTC offset |
| `SYSUTCDATETIME()` | `datetime2(7)` | 100 ns | UTC, high precision |
| `GETUTCDATE()` | `datetime` | ~3.33 ms | UTC, legacy precision |

**Best practice:** Use `SYSDATETIME()` for local server time, `SYSUTCDATETIME()` for UTC. Avoid mixing `datetime` and `datetime2` columns in the same schema.

```sql
-- Current UTC in datetime2:
SELECT SYSUTCDATETIME();

-- Today's date (time stripped):
SELECT CAST(SYSDATETIME() AS DATE);  -- returns date type, no time component
```

### Date Parts and Arithmetic

```sql
-- DATEPART(part, date): returns int
SELECT DATEPART(year,  '2025-07-04');  -- 2025
SELECT DATEPART(month, '2025-07-04');  -- 7
SELECT DATEPART(day,   '2025-07-04');  -- 4
SELECT DATEPART(dw,    '2025-07-04');  -- depends on @@DATEFIRST; not portable
SELECT DATEPART(iso_week, '2025-12-29'); -- ISO week number (2025+)
-- Parts: year, quarter, month, dayofyear, day, week, weekday(dw), hour, minute,
--        second, millisecond, microsecond, nanosecond, tzoffset, iso_week

-- DATENAME: returns string (useful for month and weekday names)
SELECT DATENAME(month, '2025-07-04');    -- 'July'
SELECT DATENAME(weekday, '2025-07-04'); -- 'Friday'  (locale-dependent)

-- YEAR() / MONTH() / DAY() — shortcuts for DATEPART
SELECT YEAR('2025-07-04'), MONTH('2025-07-04'), DAY('2025-07-04'); -- 2025, 7, 4

-- DATEADD(part, number, date): add/subtract intervals
SELECT DATEADD(day,    7, '2025-07-04');    -- 2025-07-11
SELECT DATEADD(month, -3, '2025-07-04');   -- 2025-04-04
SELECT DATEADD(year,   1, '2025-07-04');   -- 2026-07-04
SELECT DATEADD(second, 90, '2025-07-04');  -- 2025-07-04 00:01:30

-- DATEDIFF(part, start, end): integer difference in specified unit (truncated, not rounded)
SELECT DATEDIFF(day,   '2025-01-01', '2025-07-04');  -- 184
SELECT DATEDIFF(month, '2025-01-31', '2025-02-01');  -- 1 (month boundary crossed once)
SELECT DATEDIFF(year,  '2025-12-31', '2026-01-01');  -- 1 (year boundary crossed)
-- ⚠ DATEDIFF counts boundary crossings, not calendar units elapsed
-- '2025-01-31' to '2025-02-01' is 1 day but also 1 month by DATEDIFF(month,...)

-- DATEDIFF_BIG (2016+): returns bigint; use when diff in seconds/ms overflows int
SELECT DATEDIFF_BIG(millisecond, '2000-01-01', '2025-07-04');  -- ~800 billion ms

-- EOMONTH(date [, offset]): last day of the month
SELECT EOMONTH('2025-02-01');        -- 2025-02-28
SELECT EOMONTH('2025-02-01', 1);     -- 2025-03-31 (next month)
SELECT EOMONTH('2024-02-01');        -- 2024-02-29 (leap year)

-- First day of month: DATEADD(day, 1-DAY(date), date) or DATEFROMPARTS
SELECT DATEADD(day, 1 - DAY('2025-07-15'), '2025-07-15');  -- 2025-07-01
```

> [!NOTE] SQL Server 2016
> `DATEDIFF_BIG` is new in SQL Server 2016.

### Construction and Parsing

```sql
-- DATEFROMPARTS / DATETIME2FROMPARTS / etc.
SELECT DATEFROMPARTS(2025, 7, 4);                      -- date: 2025-07-04
SELECT TIMEFROMPARTS(14, 30, 0, 0, 0);                 -- time: 14:30:00
SELECT DATETIMEFROMPARTS(2025, 7, 4, 14, 30, 0, 0);   -- datetime
SELECT DATETIME2FROMPARTS(2025, 7, 4, 14, 30, 0, 0, 7); -- datetime2(7)
SELECT DATETIMEOFFSETFROMPARTS(2025, 7, 4, 14, 30, 0, 0, -5, 0, 7); -- datetimeoffset

-- Parsing strings: prefer TRY_CONVERT for safety
SELECT TRY_CONVERT(DATE, '2025-07-04');          -- 2025-07-04 (ISO 8601 — always works)
SELECT TRY_CONVERT(DATE, '07/04/2025', 101);     -- 2025-07-04 (US format, style 101)
SELECT TRY_CONVERT(DATE, '04-07-2025', 105);     -- 2025-07-04 (Italian, style 105)
SELECT TRY_CONVERT(DATETIME2, '2025-07-04T14:30:00.000', 126);  -- ISO 8601

-- PARSE: culture-aware but CLR-dependent and slow; avoid in set-based queries
SELECT TRY_PARSE('July 4, 2025' AS DATE USING 'en-US');  -- 2025-07-04
```

**Recommended date string formats (sargable and portable):**
- `YYYY-MM-DD` → always safe as string literal
- `YYYYMMDD` → safe, unambiguous
- Avoid `MM/DD/YYYY` (locale-dependent, misread as DD/MM/YYYY on European servers)

### AT TIME ZONE

```sql
-- Convert a datetime2 (assumed local) to datetimeoffset, then reinterpret in another zone
-- Available time zone names from: SELECT * FROM sys.time_zone_info

-- Mark a naive datetime2 as being in a specific zone:
DECLARE @local DATETIME2 = '2025-07-04 14:30:00';
SELECT @local AT TIME ZONE 'Eastern Standard Time';
-- Returns datetimeoffset: 2025-07-04 14:30:00.0000000 -04:00 (EDT offset in summer)

-- Convert between zones: chain two AT TIME ZONE calls
SELECT @local
  AT TIME ZONE 'Eastern Standard Time'   -- step 1: attach Eastern offset
  AT TIME ZONE 'UTC';                    -- step 2: convert to UTC
-- Returns: 2025-07-04 18:30:00.0000000 +00:00

-- Convert stored UTC to local display time:
SELECT CreatedAtUtc AT TIME ZONE 'UTC' AT TIME ZONE 'Eastern Standard Time'
FROM dbo.Events;

-- ⚠ 'Eastern Standard Time' is always the ID regardless of DST —
--   SQL Server adjusts offset automatically for DST transitions
-- ⚠ AT TIME ZONE is not sargable — wrap the column with it kills seeks
--   Store timestamps in UTC; apply AT TIME ZONE only in the SELECT list

-- Full list of supported zone names:
SELECT name, current_utc_offset, is_currently_dst
FROM sys.time_zone_info
ORDER BY name;
```

> [!NOTE] SQL Server 2016
> `AT TIME ZONE` and `sys.time_zone_info` are new in SQL Server 2016.

### datetime vs datetime2 vs datetimeoffset

| Feature | `datetime` | `datetime2` | `datetimeoffset` |
|---|---|---|---|
| Range | 1753-01-01 to 9999-12-31 | 0001-01-01 to 9999-12-31 | Same as datetime2 |
| Precision | ~3.33 ms | 100 ns (scale 0–7) | 100 ns (scale 0–7) |
| Storage | 8 bytes | 6–8 bytes (scale-dependent) | 8–10 bytes |
| UTC offset | No | No | Yes |
| ANSI/ISO compliant | No | Yes | Yes |
| Default precision | Fixed | Configurable | Configurable |
| Use with AT TIME ZONE | No (implicit cast) | Yes (primary use) | Yes |

**Recommendation:** Use `datetime2(7)` for new columns. Only use `datetime` for legacy compatibility. Use `datetimeoffset` when you need to preserve the original local time **and** UTC offset (e.g., IoT data from multiple regions, audit logs).

**Common gotchas:**
```sql
-- datetime rounds to nearest .000, .003, or .007 seconds:
SELECT CAST('2025-07-04 14:30:00.001' AS DATETIME);  -- 2025-07-04 14:30:00.000 (rounded!)
SELECT CAST('2025-07-04 14:30:00.002' AS DATETIME);  -- 2025-07-04 14:30:00.003 (rounded up!)

-- datetime2 stores exactly what you give it:
SELECT CAST('2025-07-04 14:30:00.001' AS DATETIME2);  -- 2025-07-04 14:30:00.0010000

-- datetime cannot be used with AT TIME ZONE without an implicit cast to datetime2
-- ⚠ That implicit cast may introduce a brief precision loss
```

### Common Date Patterns

```sql
-- ── Truncation ──────────────────────────────────────────────────────────────
-- Truncate to day (remove time component):
SELECT CAST(SYSDATETIME() AS DATE);               -- date type (no time)
SELECT DATEADD(day, DATEDIFF(day, 0, SYSDATETIME()), 0);  -- datetime; old pattern

-- Truncate to hour:
SELECT DATEADD(hour, DATEDIFF(hour, 0, SYSDATETIME()), 0);

-- Truncate to month start:
SELECT DATEFROMPARTS(YEAR(SYSDATETIME()), MONTH(SYSDATETIME()), 1);

-- ── Date ranges ──────────────────────────────────────────────────────────────
-- "Today" rows (sargable on a datetime2 column):
DECLARE @today DATE = CAST(SYSDATETIME() AS DATE);
WHERE OrderDate >= @today
  AND OrderDate <  DATEADD(day, 1, @today);
-- ⚠ Never use: WHERE CAST(OrderDate AS DATE) = @today  — not sargable

-- Current month:
DECLARE @monthStart DATE = DATEFROMPARTS(YEAR(SYSDATETIME()), MONTH(SYSDATETIME()), 1);
WHERE OrderDate >= @monthStart
  AND OrderDate <  DATEADD(month, 1, @monthStart);

-- ── Age calculation ───────────────────────────────────────────────────────────
-- Proper age in years (DATEDIFF alone is wrong — see gotcha):
DECLARE @dob DATE = '1985-11-15';
DECLARE @today2 DATE = CAST(SYSDATETIME() AS DATE);
SELECT DATEDIFF(year, @dob, @today2)
     - CASE WHEN MONTH(@today2) * 100 + DAY(@today2)
                < MONTH(@dob) * 100 + DAY(@dob) THEN 1 ELSE 0 END AS Age;

-- ── Fiscal / calendar helpers ─────────────────────────────────────────────────
-- ISO week number (week containing Thursday):
SELECT DATEPART(iso_week, '2025-12-29');  -- 1 (belongs to week 1 of 2026!)

-- Day of week independent of @@DATEFIRST:
-- Monday=1 through Sunday=7
SELECT (DATEPART(weekday, SYSDATETIME()) + @@DATEFIRST + 5) % 7 + 1;
```

---

## Math and Numeric Functions

```sql
-- ── Rounding ─────────────────────────────────────────────────────────────────
SELECT ROUND(2.5, 0);    -- 3.0   (rounds half away from zero for .5 exactly)
SELECT ROUND(3.5, 0);    -- 4.0
SELECT ROUND(-2.5, 0);   -- -3.0  (rounds away from zero)
SELECT ROUND(2.456, 2);  -- 2.460
-- Second arg = negative: round to tens/hundreds
SELECT ROUND(1234, -2);  -- 1200.0

SELECT FLOOR(2.9);    -- 2    (largest integer ≤ input)
SELECT FLOOR(-2.1);   -- -3
SELECT CEILING(2.1);  -- 3    (smallest integer ≥ input)
SELECT CEILING(-2.9); -- -2

-- TRUNCATE equivalent (no TRUNCATE function — use ROUND with third arg):
SELECT ROUND(2.9876, 2, 1);  -- 2.9800  (truncate toward zero, not round)

-- ── Absolute value, sign ─────────────────────────────────────────────────────
SELECT ABS(-42);    -- 42
SELECT SIGN(-5);    -- -1
SELECT SIGN(0);     -- 0
SELECT SIGN(7);     -- 1

-- ── Power, roots, logs ───────────────────────────────────────────────────────
SELECT POWER(2, 10);         -- 1024
SELECT SQRT(144);            -- 12.0
SELECT EXP(1);               -- 2.71828... (e^1)
SELECT LOG(EXP(1));          -- 1.0 (natural log)
SELECT LOG(100, 10);         -- 2.0 (log base 10)
SELECT LOG10(1000);          -- 3.0 (shortcut for log base 10)

-- ── Modulo ───────────────────────────────────────────────────────────────────
SELECT 17 % 5;   -- 2
-- ⚠ Modulo on negative numbers:
SELECT -17 % 5;  -- -2  (result takes sign of dividend, not divisor)

-- ── Random ───────────────────────────────────────────────────────────────────
SELECT RAND();              -- float in [0, 1), same seed per query if called once
SELECT RAND(CHECKSUM(NEWID()));  -- truly random per row (seed changes each call)
-- Random integer in [low, high]:
DECLARE @low INT = 1, @high INT = 100;
SELECT @low + ABS(CHECKSUM(NEWID())) % (@high - @low + 1);

-- ── Trig ─────────────────────────────────────────────────────────────────────
SELECT SIN(PI() / 2);   -- 1.0
SELECT COS(0);          -- 1.0
SELECT TAN(PI() / 4);   -- 1.0 (approx)
SELECT DEGREES(PI());   -- 180.0
SELECT RADIANS(180.0);  -- 3.14159...
SELECT PI();            -- 3.14159265358979

-- ── Greatest / Least (2022+) ─────────────────────────────────────────────────
SELECT GREATEST(1, 5, 3);        -- 5
SELECT LEAST(1, 5, 3);           -- 1
SELECT GREATEST(NULL, 5, 3);     -- 5  (NULLs ignored, unlike MAX aggregate)
SELECT GREATEST(NULL, NULL);     -- NULL (all NULL → NULL)
```

> [!NOTE] SQL Server 2022
> `GREATEST` and `LEAST` scalar functions are new in SQL Server 2022. On earlier versions use `(SELECT MAX(v) FROM (VALUES(a),(b),(c)) t(v))`.

---

## Type Conversion Functions

| Function | On error | Notes |
|---|---|---|
| `CAST(x AS type)` | Error | ANSI SQL; preferred for portability |
| `CONVERT(type, x [, style])` | Error | SQL Server extension; use for `style` parameter |
| `TRY_CAST(x AS type)` | NULL | Safe cast; 2012+ |
| `TRY_CONVERT(type, x [, style])` | NULL | Safe convert; 2012+ |
| `PARSE(x AS type [USING culture])` | Error | CLR-backed; slow; avoid in set queries |
| `TRY_PARSE(x AS type [USING culture])` | NULL | Same but safe; slow |

```sql
-- CAST vs CONVERT: functionally identical except CONVERT has style param
SELECT CAST('2025-07-04' AS DATE);
SELECT CONVERT(DATE, '2025-07-04');
SELECT CONVERT(VARCHAR(10), SYSDATETIME(), 120);  -- '2025-07-04'  (style 120 = ODBC canonical)

-- Common CONVERT date styles:
-- 101  mm/dd/yyyy         US
-- 103  dd/mm/yyyy         British/French
-- 112  yyyymmdd           ISO — no separator
-- 120  yyyy-mm-dd hh:mi:ss  ODBC canonical (most useful)
-- 126  yyyy-mm-ddThh:mi:ss.mmm  ISO 8601
-- 127  yyyy-mm-ddThh:mi:ss.mmmZ UTC ISO 8601

-- Safe conversion pattern:
SELECT id,
       TRY_CAST(raw_date AS DATE) AS ParsedDate,
       CASE WHEN TRY_CAST(raw_date AS DATE) IS NULL
            THEN 'Invalid: ' + raw_date
            ELSE NULL END AS ParseError
FROM dbo.StagingTable;

-- ⚠ Implicit conversion can kill index seeks:
-- Bad — implicit int→varchar conversion:
WHERE VarcharColumn = 42          -- forces table scan (implicit cast on column side)
-- Good:
WHERE VarcharColumn = '42'        -- seek-able

-- ⚠ PARSE / TRY_PARSE involve .NET CLR: ~10–20× slower than TRY_CONVERT
-- Use only when you genuinely need culture-aware parsing (e.g., 'July 4, 2025')
```

---

## FORMAT Function

```sql
-- FORMAT(value, format [, culture]): returns NVARCHAR; .NET format strings
SELECT FORMAT(1234567.89, 'N2', 'en-US');   -- '1,234,567.89'
SELECT FORMAT(1234567.89, 'N2', 'de-DE');   -- '1.234.567,89'
SELECT FORMAT(0.1234, 'P1', 'en-US');       -- '12.3 %'
SELECT FORMAT(42, 'D6');                    -- '000042'  (zero-padded integer)
SELECT FORMAT(SYSDATETIME(), 'yyyy-MM-dd'); -- '2025-07-04'
SELECT FORMAT(SYSDATETIME(), 'dddd, MMMM d, yyyy', 'en-US'); -- 'Friday, July 4, 2025'

-- Currency:
SELECT FORMAT(9.99, 'C', 'en-US');   -- '$9.99'
SELECT FORMAT(9.99, 'C', 'de-DE');   -- '9,99 €'
```

> [!WARNING] Performance
> `FORMAT` is CLR-backed and can be **10–50× slower** than `CAST`/`CONVERT` equivalents. Avoid in `WHERE` clauses or large result sets. Prefer `CONVERT(VARCHAR, ..., style)` for date formatting and `CAST` + arithmetic for number formatting when performance matters.

---

## CHOOSE and IIF

```sql
-- IIF(condition, true_val, false_val): shorthand for CASE WHEN
SELECT IIF(1 > 0, 'Yes', 'No');           -- 'Yes'
SELECT IIF(NULL > 0, 'Yes', 'No');        -- 'No'  (unknown → false branch)
-- Equivalent to: CASE WHEN 1 > 0 THEN 'Yes' ELSE 'No' END

-- CHOOSE(index, val1, val2, ...): returns the Nth value (1-based)
SELECT CHOOSE(2, 'Alice', 'Bob', 'Carol');  -- 'Bob'
SELECT CHOOSE(0, 'Alice', 'Bob');           -- NULL  (out of range → NULL)
SELECT CHOOSE(99, 'Alice', 'Bob');          -- NULL

-- Map DATEPART to name without DATENAME (locale-independent):
SELECT CHOOSE(DATEPART(month, SYSDATETIME()),
  'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec');
```

---

## Gotchas / Anti-patterns

1. **`+` with NULL silently returns NULL.** Replace `col1 + ' ' + col2` with `CONCAT(col1, ' ', col2)` to safely handle NULLs.

2. **`DATEDIFF(year/month, ...)` counts boundary crossings, not elapsed units.**
   `DATEDIFF(year, '2025-12-31', '2026-01-01')` = 1, even though only 1 day elapsed.
   For age-in-years, subtract 1 if the birthday hasn't occurred this year yet.

3. **`DATEPART(dw, ...)` depends on `@@DATEFIRST`** — the same date returns different integers on different servers. Use `DATEPART(iso_week, ...)` or the modulo formula above for portable weekday logic.

4. **`AT TIME ZONE` on a column is not sargable.** Store timestamps in UTC; apply time zone conversion in the `SELECT` list only, not in `WHERE`.

5. **`ROUND` in SQL Server rounds half-away-from-zero**, not banker's rounding (round-half-to-even). `ROUND(2.5, 0)` = 3, `ROUND(3.5, 0)` = 4 — both round up.

6. **`FORMAT` is slow.** The CLR startup cost makes it unsuitable for high-volume queries. Use `CONVERT(VARCHAR, ..., 120)` for dates and arithmetic for zero-padding.

7. **`LEN` strips trailing spaces; `DATALENGTH` does not.** `LEN('hi  ')` = 2, `DATALENGTH('hi  ')` = 4. This means `WHERE col = 'hi'` and `WHERE col = 'hi  '` return the same rows by default (trailing space insensitivity in SQL Server's default collation).

8. **`TRIM` in 2017+ strips individual characters from a set, not a substring prefix.**
   `TRIM('abc' FROM 'abcHello')` → strips 'a', 'b', 'c' individually from each end, not the string `'abc'` as a unit.

9. **`STRING_SPLIT` order not guaranteed pre-2022.** If you need ordered output, upgrade to 2022 and use `WITH ORDINAL`, or use a number table / JSON array workaround.

10. **Implicit conversion warning in execution plans.** If you see "Type conversion in expression may affect 'CardinalityEstimate' in query plan choice" — a column is being implicitly cast, killing seeks. Fix by matching literal types to column types.

11. **`PARSE` / `TRY_PARSE` spawn CLR.** They're convenient for culture-aware parsing but carry CLR startup overhead and are blocked if CLR is disabled (`sp_configure 'clr enabled'`). Prefer `TRY_CONVERT` with a style code.

12. **`RAND()` without a seed returns the same value for all rows in a single query.** Use `RAND(CHECKSUM(NEWID()))` or `NEWID()` directly for per-row randomness.

---

## See Also

- `references/02-syntax-dql.md` — window functions (LAG, LEAD, NTILE), PIVOT
- `references/25-null-handling.md` — ISNULL vs COALESCE, three-valued logic
- `references/26-collation.md` — how collation affects string comparison functions
- `references/19-json-xml.md` — STRING_ESCAPE for JSON, FOR XML string aggregation
- `references/23-dynamic-sql.md` — QUOTENAME (string safety in dynamic SQL)
- `references/29-query-plans.md` — implicit conversion warnings in execution plans

---

## Sources

[^1]: [String Functions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/functions) — built-in string functions overview and categories
[^2]: [Date and Time Data Types and Functions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/date-and-time-data-types-and-functions-transact-sql) — date/time types, precision, and function reference
[^3]: [Mathematical Functions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/mathematical-functions-transact-sql) — ABS, ROUND, POWER, SQRT, LOG, trig, and other numeric functions
[^4]: [AT TIME ZONE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/at-time-zone-transact-sql) — converting datetime values across time zones with DST handling
[^5]: [TRIM (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/trim-transact-sql) — removing space or specified characters from string start/end
[^6]: [STRING_SPLIT (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/string-split-transact-sql) — table-valued function splitting strings by delimiter with optional ordinal
[^7]: [STRING_AGG (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/string-agg-transact-sql) — aggregate function concatenating row values with separator and optional ordering
[^8]: [FORMAT (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/format-transact-sql) — CLR-backed locale-aware formatting for dates and numbers
[^9]: [GREATEST (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/logical-functions-greatest-transact-sql) — returns maximum value from a list of expressions (SQL Server 2022+)
[^10]: [T-SQL Fundamentals, 4th Edition](https://www.microsoftpressstore.com/store/t-sql-fundamentals-9780138102104) — Itzik Ben-Gan (Microsoft Press, 2023, ISBN 978-0138102104); covers date truncation patterns and string aggregation techniques for SQL Server 2022

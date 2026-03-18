# 25 — NULL Handling

> Three-valued logic, ISNULL/COALESCE/NULLIF, NULLs in indexes/aggregates/JOINs, IS [NOT] DISTINCT FROM

## Table of Contents

1. [When to Use This Reference](#1-when-to-use-this-reference)
2. [Three-Valued Logic](#2-three-valued-logic)
3. [NULL in WHERE Clauses](#3-null-in-where-clauses)
4. [NULL in JOIN Conditions](#4-null-in-join-conditions)
5. [NULL in Aggregates](#5-null-in-aggregates)
6. [NULL in Expressions and Operators](#6-null-in-expressions-and-operators)
7. [ISNULL vs COALESCE vs NULLIF](#7-isnull-vs-coalesce-vs-nullif)
8. [IS DISTINCT FROM / IS NOT DISTINCT FROM (2022+)](#8-is-distinct-from--is-not-distinct-from-2022)
9. [NULL in UNIQUE Constraints and Indexes](#9-null-in-unique-constraints-and-indexes)
10. [NULL in Filtered Indexes (Workaround)](#10-null-in-filtered-indexes-workaround)
11. [NULL in ORDER BY, GROUP BY, PARTITION BY](#11-null-in-order-by-group-by-partition-by)
12. [NULL in CHECK Constraints](#12-null-in-check-constraints)
13. [NULL in NOT IN / NOT EXISTS / EXCEPT](#13-null-in-not-in--not-exists--except)
14. [NULL in String Concatenation](#14-null-in-string-concatenation)
15. [NULL in SET ANSI_NULLS](#15-null-in-set-ansi_nulls)
16. [Common NULL Patterns](#16-common-null-patterns)
17. [Metadata Queries](#17-metadata-queries)
18. [Gotchas / Anti-Patterns](#18-gotchas--anti-patterns)
19. [See Also](#19-see-also)
20. [Sources](#sources)

---

## 1. When to Use This Reference

Load this file when:
- Debugging queries that silently exclude or include rows because of NULL
- Writing JOIN conditions involving nullable columns
- Using NOT IN and getting surprising empty results
- Designing UNIQUE constraints on nullable columns
- Using ISNULL/COALESCE and needing the type/precedence difference
- Upgrading to SQL Server 2022 and evaluating IS [NOT] DISTINCT FROM
- Explaining why `WHERE col = NULL` never returns rows

---

## 2. Three-Valued Logic

SQL uses three truth values: **TRUE**, **FALSE**, and **UNKNOWN**.

Any comparison involving NULL produces UNKNOWN — not TRUE or FALSE:

```sql
NULL = NULL    -- UNKNOWN
NULL <> NULL   -- UNKNOWN
NULL = 1       -- UNKNOWN
NULL > 1       -- UNKNOWN
NULL IS NULL   -- TRUE  (special syntax)
NULL IS NOT NULL -- FALSE
```

**Truth table for AND:**

| A       | B       | A AND B |
|---------|---------|---------|
| TRUE    | TRUE    | TRUE    |
| TRUE    | FALSE   | FALSE   |
| TRUE    | UNKNOWN | UNKNOWN |
| FALSE   | FALSE   | FALSE   |
| FALSE   | UNKNOWN | FALSE   |
| UNKNOWN | UNKNOWN | UNKNOWN |

**Truth table for OR:**

| A       | B       | A OR B  |
|---------|---------|---------|
| TRUE    | TRUE    | TRUE    |
| TRUE    | FALSE   | TRUE    |
| TRUE    | UNKNOWN | TRUE    |
| FALSE   | FALSE   | FALSE   |
| FALSE   | UNKNOWN | UNKNOWN |
| UNKNOWN | UNKNOWN | UNKNOWN |

**Truth table for NOT:**

| A       | NOT A   |
|---------|---------|
| TRUE    | FALSE   |
| FALSE   | TRUE    |
| UNKNOWN | UNKNOWN |

**Critical rule:** WHERE and JOIN ON only keep rows where the condition evaluates to **TRUE**. UNKNOWN rows are discarded — they behave like FALSE for row filtering purposes but are logically distinct.

---

## 3. NULL in WHERE Clauses

```sql
-- These NEVER return rows:
WHERE col = NULL        -- always UNKNOWN
WHERE col != NULL       -- always UNKNOWN
WHERE col <> NULL       -- always UNKNOWN

-- These work correctly:
WHERE col IS NULL
WHERE col IS NOT NULL

-- Watch out with NOT:
WHERE NOT (col = 1)     -- excludes NULLs (evaluates to UNKNOWN, row dropped)
WHERE col <> 1          -- excludes NULLs for the same reason
-- To include NULLs in the "not 1" case:
WHERE col <> 1 OR col IS NULL
```

**Pattern: optional filter that treats NULL as "match all":**

```sql
-- Returns rows where @Filter is NULL (no filter applied) OR col matches
WHERE (@Filter IS NULL OR col = @Filter)
```

---

## 4. NULL in JOIN Conditions

NULLs in join columns cause rows to be excluded — NULL does not join to NULL:

```sql
-- Setup
CREATE TABLE #A (id INT, val INT NULL);
CREATE TABLE #B (id INT, val INT NULL);
INSERT #A VALUES (1, 10), (2, NULL), (3, 20);
INSERT #B VALUES (1, 10), (2, NULL), (4, 30);

-- INNER JOIN: row with val=NULL does NOT join to row with val=NULL
SELECT a.id, b.id
FROM #A a
JOIN #B b ON a.val = b.val;
-- Returns: (1,1), (3, nothing) → actually only (1,1)
-- NULL=NULL is UNKNOWN → excluded

-- To join on NULL-matching columns, use:
SELECT a.id, b.id
FROM #A a
JOIN #B b ON a.val = b.val
          OR (a.val IS NULL AND b.val IS NULL);
```

> [!NOTE] SQL Server 2022
> `IS NOT DISTINCT FROM` provides a cleaner null-safe equality syntax — see [Section 8](#8-is-distinct-from--is-not-distinct-from-2022).

**LEFT JOIN null pattern:** Distinguish "no match in right table" vs "right column is NULL":

```sql
SELECT a.id,
       b.id            AS b_id,
       b.val           AS b_val,
       CASE WHEN b.id IS NULL THEN 'no match' ELSE 'matched' END AS status
FROM #A a
LEFT JOIN #B b ON a.id = b.id;
```

---

## 5. NULL in Aggregates

Aggregate functions **ignore NULLs** — except `COUNT(*)`:

```sql
CREATE TABLE #Sales (amount DECIMAL(10,2) NULL);
INSERT #Sales VALUES (100), (200), (NULL), (NULL), (300);

SELECT
    COUNT(*)        AS all_rows,         -- 5  (includes NULLs)
    COUNT(amount)   AS non_null_rows,    -- 3  (ignores NULLs)
    SUM(amount)     AS total,            -- 600 (ignores NULLs)
    AVG(amount)     AS average,          -- 200 = 600/3 (denominator excludes NULLs!)
    MIN(amount)     AS minimum,          -- 100
    MAX(amount)     AS maximum           -- 300
FROM #Sales;

-- If you want AVG over all rows (treating NULL as 0):
SELECT AVG(ISNULL(amount, 0)) AS avg_incl_null_as_zero  -- 120 = 600/5
FROM #Sales;
```

**AVG trap:** AVG computes `SUM(col) / COUNT(col)`. If nulls represent "zero value" in your domain, substitute them before averaging.

**COUNT(*) vs COUNT(1) vs COUNT(col):**

| Expression   | Counts                        | NULL behavior      |
|--------------|-------------------------------|--------------------|
| `COUNT(*)`   | All rows in group             | Includes NULLs     |
| `COUNT(1)`   | All rows in group             | Includes NULLs     |
| `COUNT(col)` | Rows where col IS NOT NULL    | Excludes NULLs     |
| `COUNT(DISTINCT col)` | Distinct non-null values | Excludes NULLs |

---

## 6. NULL in Expressions and Operators

Any arithmetic or string expression with NULL produces NULL:

```sql
SELECT 1 + NULL         -- NULL
SELECT 'hello' + NULL   -- NULL (with ANSI_NULLS ON)
SELECT NULL / 0         -- NULL (not an error)
SELECT ABS(NULL)        -- NULL
SELECT UPPER(NULL)      -- NULL
```

**CASE expressions and NULL:**

```sql
-- Simple CASE: NULL does NOT match any value
SELECT CASE NULL
    WHEN NULL THEN 'null'   -- never matches
    ELSE 'other'            -- always goes here
END;   -- returns 'other'

-- Searched CASE: use IS NULL explicitly
SELECT CASE
    WHEN col IS NULL THEN 'null'
    WHEN col = 1    THEN 'one'
    ELSE 'other'
END
FROM t;
```

**IN list and NULL:**

```sql
-- NULL in the IN list does NOT cause the NULL row to match:
SELECT * FROM t WHERE col IN (1, NULL, 3);
-- Equivalent to: col=1 OR col=NULL OR col=3
-- col=NULL is UNKNOWN, so NULLs in col are excluded
```

---

## 7. ISNULL vs COALESCE vs NULLIF

### ISNULL

```sql
ISNULL(check_expression, replacement_value)
```

- Returns `replacement_value` if `check_expression` IS NULL
- Result type = type of `check_expression` (replacement is implicitly cast)
- Takes **exactly 2 arguments**
- SQL Server extension (not ANSI standard)

```sql
SELECT ISNULL(NULL, 'default')           -- 'default'
SELECT ISNULL(CAST(NULL AS INT), 42)     -- 42 (INT)
SELECT ISNULL(CAST(NULL AS VARCHAR(5)), 'toolong')  -- 'toolon' (truncated to 5!)
```

**Type precedence trap with ISNULL:**
The result type is the type of the first argument. The replacement value is silently truncated or converted.

### COALESCE

```sql
COALESCE(expression1, expression2, ..., expressionN)
```

- Returns the first non-NULL expression
- ANSI SQL standard
- Can take **any number of arguments**
- Result type is determined by **data type precedence** across all arguments (highest precedence type wins)
- Internally expanded by the optimizer to a searched CASE expression

```sql
SELECT COALESCE(NULL, NULL, 'third')     -- 'third'
SELECT COALESCE(col1, col2, 'fallback') FROM t;

-- Type precedence example:
SELECT COALESCE(NULL, 42)               -- 42 (INT — higher precedence than NULL)
SELECT COALESCE(CAST(NULL AS FLOAT), 42)  -- 42.0 (FLOAT wins over INT)
```

**COALESCE vs ISNULL summary:**

| Feature                   | ISNULL          | COALESCE           |
|---------------------------|-----------------|--------------------|
| ANSI standard             | No              | Yes                |
| Number of arguments       | Exactly 2       | 2 or more          |
| Result type               | First argument  | Highest precedence |
| Optimizer expansion       | Direct          | CASE expression    |
| Subquery safe             | Evaluated once  | May evaluate twice |
| Indexed computed column   | Works well      | May not inline     |

**COALESCE subquery double-evaluation:**

```sql
-- COALESCE can evaluate the subquery twice (expanded to CASE):
SELECT COALESCE((SELECT MAX(id) FROM t WHERE active = 1), 0)
-- May run the subquery once for the IS NULL check, once for the value

-- Safer: use ISNULL or assign to variable first:
DECLARE @val INT = (SELECT MAX(id) FROM t WHERE active = 1);
SELECT ISNULL(@val, 0);
```

### NULLIF

```sql
NULLIF(expression1, expression2)
```

Returns NULL if both expressions are equal; otherwise returns `expression1`.
Useful for converting sentinel values (e.g., empty string, zero) to NULL:

```sql
SELECT NULLIF(col, '')    -- returns NULL where col = ''
SELECT NULLIF(col, 0)     -- returns NULL where col = 0
SELECT NULLIF(col, col)   -- always NULL (trivial, don't do this)

-- Avoid divide-by-zero:
SELECT numerator / NULLIF(denominator, 0) FROM t;
-- Returns NULL instead of divide-by-zero error when denominator = 0
```

**Combining NULLIF with ISNULL:**

```sql
-- Treat both '' and NULL as missing, then provide default:
SELECT ISNULL(NULLIF(email, ''), 'unknown@example.com') FROM users;
```

---

## 8. IS DISTINCT FROM / IS NOT DISTINCT FROM (2022+)

> [!NOTE] SQL Server 2022
> `IS DISTINCT FROM` and `IS NOT DISTINCT FROM` are new in SQL Server 2022 (compatibility level 160). They treat NULL as a known value for comparison purposes, eliminating the need for verbose NULL-safe equality patterns.

```sql
-- Pre-2022: null-safe equality required verbose pattern
WHERE (col = @val OR (col IS NULL AND @val IS NULL))

-- 2022+: null-safe equality
WHERE col IS NOT DISTINCT FROM @val

-- Pre-2022: null-safe inequality
WHERE NOT (col = @val OR (col IS NULL AND @val IS NULL))
-- ...or equivalently:
WHERE (col <> @val OR (col IS NULL) <> (@val IS NULL))

-- 2022+: null-safe inequality
WHERE col IS DISTINCT FROM @val
```

**Truth table for IS [NOT] DISTINCT FROM:**

| a      | b      | a IS DISTINCT FROM b | a IS NOT DISTINCT FROM b |
|--------|--------|----------------------|--------------------------|
| 1      | 1      | FALSE                | TRUE                     |
| 1      | 2      | TRUE                 | FALSE                    |
| 1      | NULL   | TRUE                 | FALSE                    |
| NULL   | NULL   | FALSE                | TRUE                     |

**JOIN with IS NOT DISTINCT FROM (null-safe join):**

```sql
SELECT a.id, b.id
FROM #A a
JOIN #B b ON a.val IS NOT DISTINCT FROM b.val;
-- NULL in a.val matches NULL in b.val
```

**Note:** `IS NOT DISTINCT FROM` is logically equivalent to `=` when no NULLs are involved, but has different cardinality estimation implications. The optimizer may not use index seeks on `IS NOT DISTINCT FROM` predicates as efficiently as on `=` predicates. Test with `SET STATISTICS IO ON` on heavily used queries.

---

## 9. NULL in UNIQUE Constraints and Indexes

SQL Server treats NULL as a distinct value for UNIQUE constraints — **but allows multiple NULLs** in a single-column UNIQUE constraint:

```sql
CREATE TABLE #u (id INT IDENTITY, val INT NULL, UNIQUE (val));
INSERT #u (val) VALUES (1);   -- OK
INSERT #u (val) VALUES (1);   -- ERROR: duplicate key value 1
INSERT #u (val) VALUES (NULL); -- OK
INSERT #u (val) VALUES (NULL); -- OK! Second NULL is allowed
```

This is per ANSI SQL standard: NULL ≠ NULL, so two NULLs are not duplicates.

**Multi-column UNIQUE with NULLs:**

If any column in the UNIQUE constraint is NULL, the row is always considered unique (no violation):

```sql
CREATE TABLE #m (a INT NULL, b INT NULL, UNIQUE (a, b));
INSERT #m VALUES (1, 1);     -- OK
INSERT #m VALUES (1, 1);     -- ERROR: duplicate (1,1)
INSERT #m VALUES (1, NULL);  -- OK
INSERT #m VALUES (1, NULL);  -- OK! Allowed because b is NULL
INSERT #m VALUES (NULL, NULL); -- OK
INSERT #m VALUES (NULL, NULL); -- OK! Both NULL — always allowed
```

**Practical consequence:** If you need "only one active row per entity", a UNIQUE constraint on `(entity_id, deleted_at)` where `deleted_at` is NULL for active rows will allow multiple NULL rows — defeating the intent. Use a filtered unique index instead:

```sql
-- See Section 10 for the filtered index approach
```

---

## 10. NULL in Filtered Indexes (Workaround)

A **filtered index** can include or exclude NULLs explicitly, enabling patterns that UNIQUE constraints alone cannot enforce.

**Pattern: enforce uniqueness only on non-NULL values:**

```sql
-- Allow multiple NULLs but require uniqueness among non-null values
CREATE UNIQUE INDEX UX_orders_tracking_notnull
ON orders (tracking_number)
WHERE tracking_number IS NOT NULL;
-- Now: two NULLs → OK; two identical tracking numbers → ERROR
```

**Pattern: "one active row" per entity (soft delete):**

```sql
-- deleted_at IS NULL means "active"
CREATE UNIQUE INDEX UX_users_email_active
ON users (email)
WHERE deleted_at IS NULL;
-- Allows multiple deleted rows with same email, but only one active row
```

**Pattern: index NULL values specifically to find them fast:**

```sql
-- Finding orphaned rows (FK column is NULL) is a table scan without an index
-- A filtered index makes it an index seek:
CREATE INDEX IX_orders_customerid_null
ON orders (order_id)
WHERE customer_id IS NULL;

-- Now this query uses the filtered index:
SELECT order_id FROM orders WHERE customer_id IS NULL;
```

**Filtered index limitations:**
- Cannot be used when the query predicate doesn't include `WHERE customer_id IS NULL` (or an equivalent expression the optimizer can verify)
- Parameterized queries may not use filtered indexes if the parameter could take a non-matching value — the optimizer can't prove the filter always applies
- Not supported on memory-optimized (Hekaton) tables

---

## 11. NULL in ORDER BY, GROUP BY, PARTITION BY

### ORDER BY

NULLs sort **before** all non-NULL values in ascending order, and **after** all non-NULL values in descending order:

```sql
-- Values: NULL, NULL, 1, 3, 5
SELECT val FROM t ORDER BY val ASC;
-- Result: NULL, NULL, 1, 3, 5

SELECT val FROM t ORDER BY val DESC;
-- Result: 5, 3, 1, NULL, NULL

-- SQL Server has no NULLS FIRST / NULLS LAST syntax (unlike PostgreSQL/Oracle)
-- Workaround: sort NULLs last in ascending order:
SELECT val
FROM t
ORDER BY CASE WHEN val IS NULL THEN 1 ELSE 0 END, val ASC;
-- Puts NULLs last regardless of ASC/DESC on val
```

### GROUP BY

NULLs **do group together** — all NULL values in a GROUP BY column form a single group:

```sql
CREATE TABLE #g (category VARCHAR(20) NULL, amount INT);
INSERT #g VALUES ('A', 10), ('A', 20), (NULL, 30), (NULL, 40), ('B', 50);

SELECT category, SUM(amount) AS total
FROM #g
GROUP BY category;
-- Result:
-- A      30
-- B      50
-- NULL   70   ← NULLs grouped together
```

### PARTITION BY (window functions)

Same as GROUP BY — NULLs in PARTITION BY columns form their own partition:

```sql
SELECT category, amount,
       SUM(amount) OVER (PARTITION BY category) AS cat_total
FROM #g;
-- Rows where category IS NULL get their own partition (total = 70)
```

---

## 12. NULL in CHECK Constraints

CHECK constraints are satisfied by rows where the expression evaluates to **TRUE or UNKNOWN**. This means a nullable column with a CHECK constraint allows NULL values to be inserted even if they might conceptually violate the intent:

```sql
CREATE TABLE #chk (age INT NULL, CHECK (age >= 0));
INSERT #chk VALUES (25);    -- OK: TRUE
INSERT #chk VALUES (-1);    -- ERROR: FALSE
INSERT #chk VALUES (NULL);  -- OK! UNKNOWN → constraint passes

-- If you want to also prohibit NULLs, add NOT NULL:
ALTER TABLE #chk ALTER COLUMN age INT NOT NULL;
```

**Multi-column CHECK with NULL:**

```sql
CREATE TABLE #range (
    start_date DATE NULL,
    end_date   DATE NULL,
    CHECK (end_date >= start_date)  -- passes if either is NULL
);
INSERT #range VALUES ('2024-01-01', '2023-01-01');  -- ERROR: FALSE
INSERT #range VALUES (NULL, '2023-01-01');           -- OK: UNKNOWN
INSERT #range VALUES ('2024-01-01', NULL);           -- OK: UNKNOWN
```

To enforce the constraint even when one side is NULL:

```sql
CHECK (end_date IS NULL OR end_date >= start_date)
-- Now: end_date=NULL passes, but start_date=NULL with a non-null end_date
-- still passes unless you add more conditions
```

---

## 13. NULL in NOT IN / NOT EXISTS / EXCEPT

This is the most dangerous NULL behavior in SQL Server. **NOT IN with a subquery that returns any NULL causes the entire predicate to return no rows.**

```sql
CREATE TABLE #outer (id INT);
CREATE TABLE #inner (id INT NULL);
INSERT #outer VALUES (1), (2), (3);
INSERT #inner VALUES (1), (NULL);  -- note the NULL

-- NOT IN with NULL in subquery → returns ZERO rows
SELECT * FROM #outer WHERE id NOT IN (SELECT id FROM #inner);
-- Returns nothing! Because:
-- id NOT IN (1, NULL) → id<>1 AND id<>NULL → id<>1 AND UNKNOWN → UNKNOWN for all rows

-- Fix option 1: filter NULLs from subquery
SELECT * FROM #outer WHERE id NOT IN (SELECT id FROM #inner WHERE id IS NOT NULL);

-- Fix option 2: use NOT EXISTS (preferred — never affected by NULLs)
SELECT o.* FROM #outer o WHERE NOT EXISTS (SELECT 1 FROM #inner i WHERE i.id = o.id);

-- Fix option 3: LEFT JOIN anti-join
SELECT o.* FROM #outer o LEFT JOIN #inner i ON o.id = i.id WHERE i.id IS NULL;
```

**Recommendation:** Always use `NOT EXISTS` or a LEFT JOIN anti-join instead of `NOT IN` with subqueries. `NOT IN` with a literal list is safe only if you are certain no NULLs are present.

**EXCEPT and NULL:**

`EXCEPT` handles NULLs correctly — it treats NULL as equal to NULL for set difference purposes:

```sql
SELECT 1 AS x UNION ALL SELECT NULL AS x
EXCEPT
SELECT NULL AS x;
-- Returns only: 1   (NULL is correctly excluded)
```

---

## 14. NULL in String Concatenation

With `SET ANSI_NULLS ON` (default), the `+` string concatenation operator propagates NULL:

```sql
SELECT 'Hello ' + NULL + 'World'   -- NULL

-- Use COALESCE or ISNULL to guard:
SELECT 'Hello ' + ISNULL(middle_name, '') + ' World'  FROM contacts;

-- Or use CONCAT() which ignores NULLs (SQL Server 2012+):
SELECT CONCAT('Hello ', middle_name, ' World') FROM contacts;
-- Returns 'Hello  World' if middle_name IS NULL (treats NULL as empty string)
```

> [!WARNING] Behavior difference
> `+` propagates NULL; `CONCAT()` treats NULL as empty string. Choose based on your intent — `CONCAT()` silently masks missing data, while `+` forces you to handle it explicitly.

**CONCAT_WS and NULL (SQL Server 2017+):**

```sql
-- CONCAT_WS also ignores NULL arguments (but not the separator itself):
SELECT CONCAT_WS(', ', 'First', NULL, 'Last')  -- 'First, Last' (NULL skipped)
SELECT CONCAT_WS(NULL, 'First', 'Last')         -- NULL (NULL separator propagates)
```

---

## 15. NULL in SET ANSI_NULLS

`SET ANSI_NULLS` controls whether `= NULL` and `<> NULL` comparisons return FALSE instead of UNKNOWN. The default is ON (ANSI-compliant):

```sql
SET ANSI_NULLS ON;   -- default
DECLARE @x INT = NULL;
SELECT CASE WHEN @x = NULL  THEN 'equal' ELSE 'not equal' END;  -- 'not equal' (UNKNOWN → ELSE)
SELECT CASE WHEN @x IS NULL THEN 'null'  ELSE 'not null'  END;  -- 'null'

SET ANSI_NULLS OFF;  -- non-standard legacy mode
SELECT CASE WHEN @x = NULL THEN 'equal' ELSE 'not equal' END;   -- 'equal' (!!)
```

> [!WARNING] Deprecated
> `SET ANSI_NULLS OFF` is deprecated as of SQL Server 2005 and will be removed in a future version. All new code must use `SET ANSI_NULLS ON`. Stored procedures and views compiled with `ANSI_NULLS OFF` store that setting in metadata; if you need to check, query `sys.sql_modules.uses_ansi_nulls`.

**Practical implication:** Never write `WHERE col = NULL` — it fails under ANSI_NULLS ON (the current and future-only mode). Always use `IS NULL` / `IS NOT NULL`.

---

## 16. Common NULL Patterns

### Default value substitution

```sql
-- Replace NULL with domain default at output time
SELECT
    customer_name,
    ISNULL(phone, 'N/A')           AS phone,
    COALESCE(mobile, home, work, 'no phone') AS best_phone
FROM customers;
```

### Conditional aggregation ignoring unknowns

```sql
-- Count how many rows have each status, NULL status goes into "unknown"
SELECT
    ISNULL(status, 'unknown') AS status,
    COUNT(*)                   AS row_count
FROM orders
GROUP BY ISNULL(status, 'unknown');
```

### Sentinel-to-NULL conversion

```sql
-- Legacy systems often use '' or -1 or 0 as "missing" sentinel values
-- Convert to NULL for consistent handling:
UPDATE legacy_data
SET phone    = NULLIF(phone, ''),
    age      = NULLIF(age, -1),
    score    = NULLIF(score, 0)
WHERE phone = '' OR age = -1 OR score = 0;
```

### NULL-safe comparison in MERGE

```sql
-- MERGE with null-safe matching (pre-2022):
MERGE target AS t
USING source AS s
ON t.key_col = s.key_col
   AND (t.nullable_col = s.nullable_col
        OR (t.nullable_col IS NULL AND s.nullable_col IS NULL))
WHEN MATCHED THEN UPDATE SET t.val = s.val
WHEN NOT MATCHED THEN INSERT (key_col, nullable_col, val) VALUES (s.key_col, s.nullable_col, s.val);

-- SQL Server 2022:
MERGE target AS t
USING source AS s
ON t.key_col = s.key_col
   AND t.nullable_col IS NOT DISTINCT FROM s.nullable_col
WHEN MATCHED THEN UPDATE SET t.val = s.val
WHEN NOT MATCHED THEN INSERT (key_col, nullable_col, val) VALUES (s.key_col, s.nullable_col, s.val);
```

### Coalesce chain for column priority

```sql
-- Use the first non-null column across a priority chain
SELECT
    order_id,
    COALESCE(override_price, contract_price, list_price) AS final_price
FROM orders;
```

### Propagating NULL intentionally with NULLIF

```sql
-- Mark low-confidence readings as NULL for downstream processing
UPDATE sensor_readings
SET temperature = NULLIF(temperature, -999.9)  -- -999.9 = bad sensor value
WHERE sensor_id = 42;
```

---

## 17. Metadata Queries

**Find nullable columns in a table:**

```sql
SELECT
    c.name                                  AS column_name,
    t.name                                  AS data_type,
    c.is_nullable,
    c.max_length,
    c.precision,
    c.scale
FROM sys.columns c
JOIN sys.types t ON c.user_type_id = t.user_type_id
WHERE c.object_id = OBJECT_ID('dbo.orders')
ORDER BY c.column_id;
```

**Find columns with ANSI_NULLS OFF in their modules:**

```sql
SELECT
    o.name          AS module_name,
    o.type_desc,
    m.uses_ansi_nulls
FROM sys.sql_modules m
JOIN sys.objects o ON m.object_id = o.object_id
WHERE m.uses_ansi_nulls = 0;
```

**Find UNIQUE constraints that allow multiple NULLs:**

```sql
SELECT
    i.name      AS constraint_name,
    i.is_unique,
    STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns,
    -- Check if any column in the UNIQUE index is nullable
    MAX(CASE WHEN col.is_nullable = 1 THEN 1 ELSE 0 END) AS has_nullable_column
FROM sys.indexes i
JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
JOIN sys.columns c        ON ic.object_id = c.object_id AND ic.column_id = c.column_id
JOIN sys.columns col      ON ic.object_id = col.object_id AND ic.column_id = col.column_id
WHERE i.is_unique = 1
  AND i.object_id = OBJECT_ID('dbo.orders')
GROUP BY i.name, i.is_unique;
```

**Find filtered indexes (likely used for NULL exclusion):**

```sql
SELECT
    i.name          AS index_name,
    o.name          AS table_name,
    i.filter_definition,
    i.is_unique
FROM sys.indexes i
JOIN sys.objects o ON i.object_id = o.object_id
WHERE i.has_filter = 1
ORDER BY o.name, i.name;
```

---

## 18. Gotchas / Anti-Patterns

1. **`WHERE col = NULL` never returns rows.** Always use `IS NULL`. This is the single most common NULL-related mistake.

2. **NOT IN with a nullable subquery returns zero rows.** If `SELECT col FROM t` can return NULL, `x NOT IN (SELECT col FROM t)` returns nothing. Use `NOT EXISTS` or filter the subquery with `WHERE col IS NOT NULL`.

3. **AVG excludes NULLs from the denominator.** `AVG(nullable_col)` is not the same as `SUM(col) / COUNT(*)`. This means AVG "optimistically" ignores missing data. If NULLs mean "zero", use `AVG(ISNULL(col, 0))`.

4. **COALESCE may evaluate subqueries twice.** The optimizer expands `COALESCE` to a CASE expression, which can cause the argument to be evaluated twice. For expensive subqueries, assign to a variable first.

5. **ISNULL silently truncates the replacement value** to the length of the first argument. `ISNULL(CAST(NULL AS VARCHAR(5)), 'toolong')` → `'toolon'`. Use COALESCE or widen the first argument.

6. **Multi-column UNIQUE with NULL always allows duplicates.** Any NULL in any column of a composite UNIQUE constraint disables the uniqueness check for that row. Use a filtered unique index if you need "unique when none are null."

7. **NULL sorts to the beginning in ASC ORDER.** Many developers expect NULL to sort last. Use `ORDER BY CASE WHEN col IS NULL THEN 1 ELSE 0 END, col` to push NULLs to the end.

8. **CHECK constraints allow NULL rows.** A CHECK constraint `age >= 0` still allows `age = NULL` because UNKNOWN passes. Add `NOT NULL` if you also want to prohibit NULLs.

9. **Simple CASE does not match NULL.** `CASE col WHEN NULL THEN ...` never fires. Use a searched CASE with `WHEN col IS NULL THEN ...`.

10. **`IS NOT DISTINCT FROM` may prevent index seeks.** While syntactically cleaner than the null-safe OR pattern, the optimizer may not always use an index seek efficiently. In high-cardinality, high-throughput joins, benchmark both approaches.

11. **STRING_AGG and GROUP_CONCAT ignore NULLs.** `STRING_AGG(col, ',')` skips NULL values silently. If you need to represent NULLs in the concatenated output, substitute with `ISNULL(col, 'NULL')` before aggregating.

12. **Filtered index with IS NOT NULL predicate is not used when the optimizer can't infer the predicate is satisfied.** For ad-hoc parameterized queries, verify the plan actually uses the filtered index rather than scanning.

---

## 19. See Also

- [`references/02-syntax-dql.md`](02-syntax-dql.md) — WHERE clause semantics, JOIN types, NOT IN vs NOT EXISTS
- [`references/08-indexes.md`](08-indexes.md) — filtered indexes, coverage
- [`references/12-custom-defaults-rules.md`](12-custom-defaults-rules.md) — CHECK constraints, UNIQUE constraints
- [`references/13-transactions-locking.md`](13-transactions-locking.md) — RCSI and NULLs in version store
- [`references/24-string-date-math-functions.md`](24-string-date-math-functions.md) — ISNULL/COALESCE/NULLIF, CONCAT, CONCAT_WS
- [`references/51-2022-features.md`](51-2022-features.md) — IS [NOT] DISTINCT FROM

---

## Sources

[^1]: Itzik Ben-Gan, "T-SQL Fundamentals" (Microsoft Press) — three-valued logic and NULL behavior chapter
[^2]: [IS [NOT] DISTINCT FROM (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/is-distinct-from-transact-sql) — null-safe equality predicate introduced in SQL Server 2022
[^3]: [COALESCE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/coalesce-transact-sql) — returns first non-NULL expression, with CASE expansion semantics
[^4]: [ISNULL (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/isnull-transact-sql) — replaces NULL with a specified replacement value
[^5]: [NULLIF (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/nullif-transact-sql) — returns NULL if two expressions are equal
[^6]: [SET ANSI_NULLS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-ansi-nulls-transact-sql) — controls ISO-compliant NULL comparison behavior
[^7]: [Create Filtered Indexes](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/create-filtered-indexes) — filtered index design, limitations, and usage with NULL predicates
[^8]: [The Curse and Blessings of Dynamic SQL](https://sommarskog.se/dynamic_sql.html) — Erland Sommarskog's reference on dynamic SQL patterns including NULL handling

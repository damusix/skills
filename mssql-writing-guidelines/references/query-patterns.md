# Query Patterns


Patterns for writing correct, performant queries within views and stored procedures.

## Table of Contents

- [SARGability](#sargability)
- [NOT EXISTS over NOT IN](#not-exists-over-not-in)
- [Window Functions](#window-functions)
- [CROSS APPLY Patterns](#cross-apply-patterns)
- [String Aggregation](#string-aggregation)
- [Batch Operations](#batch-operations)
- [Parameter Sniffing](#parameter-sniffing)

---

## SARGability

A WHERE clause is **SARGable** (Search ARGumentable) when the query optimizer can use an index seek instead of scanning every row. The rule is simple: never wrap a column in a function or expression on the filtered side.

    -- BAD: wrapping the column forces an index scan
    WHERE YEAR(OrderDate) = 2025
    WHERE UPPER(Email) = 'FOO@BAR.COM'
    WHERE CustomerNo + 1 = @Target

    -- GOOD: isolate the column so the optimizer can seek
    WHERE OrderDate >= '2025-01-01' AND OrderDate < '2026-01-01'
    WHERE Email = 'foo@bar.com'  -- use a case-insensitive collation instead
    WHERE CustomerNo = @Target - 1

This applies equally to view WHERE clauses and procedure logic. A non-SARGable predicate in a view can silently degrade every query that uses that view.

**Common SARGability traps:**

| Non-SARGable | SARGable Alternative |
|-------------|---------------------|
| `YEAR(col) = 2025` | `col >= '2025-01-01' AND col < '2026-01-01'` |
| `CAST(col AS DATE) = @Date` | `col >= @Date AND col < DATEADD(day, 1, @Date)` |
| `ISNULL(col, '') = @Val` | `col = @Val` (ensure column is NOT NULL by design) |
| `col LIKE '%search'` | `col LIKE 'search%'` (leading wildcard kills seeks) |
| `DATEDIFF(day, col, GETDATE()) < 30` | `col > DATEADD(day, -30, GETDATE())` |

---

## NOT EXISTS over NOT IN

When checking for the absence of records in a subquery, always use `NOT EXISTS` instead of `NOT IN`. This is not about performance — the SQL Server optimizer generates the same plan for both. It is about **NULL safety**:

    -- DANGEROUS: if Subtype.AccountNo contains any NULL,
    -- this returns zero rows — always, silently, for every row
    SELECT * FROM Account
    WHERE AccountNo NOT IN (SELECT AccountNo FROM SavingsAccount);

    -- SAFE: NULLs do not affect the result
    SELECT * FROM Account A
    WHERE NOT EXISTS (
        SELECT 1 FROM SavingsAccount S
        WHERE S.AccountNo = A.AccountNo
    );

`NOT IN (1, 2, NULL)` evaluates to UNKNOWN for every row because `col <> NULL` is UNKNOWN, and `TRUE AND UNKNOWN` is UNKNOWN. The entire query silently returns nothing. `NOT EXISTS` avoids this entirely because it tests for row existence, not value equality.

**For positive checks** (`EXISTS` vs `IN`), the optimizer produces identical plans and either is fine. The preference for `EXISTS` is a consistency habit — always use `EXISTS`/`NOT EXISTS` and you never hit the NULL trap.

---

## Window Functions

Use window functions instead of self-joins or correlated subqueries for calculations that need access to other rows. They are faster (single pass over the data) and clearer.

**Running totals:**

    SELECT
        TransactionNo,
        Amount,
        SUM(Amount) OVER (ORDER BY TransactionNo ROWS UNBOUNDED PRECEDING) AS RunningBalance
    FROM Admin_Transactions_V;

Use `ROWS UNBOUNDED PRECEDING` explicitly — the default `RANGE UNBOUNDED PRECEDING` has different behavior with ties and worse performance.

**Previous/next values:**

    SELECT
        OrderNo,
        OrderDate,
        LAG(OrderDate) OVER (ORDER BY OrderNo) AS PreviousOrderDate,
        LEAD(OrderDate) OVER (ORDER BY OrderNo) AS NextOrderDate
    FROM Manager_Orders_V;

**Ranking (greatest-N-per-group):**

    -- Most recent order per customer
    SELECT * FROM (
        SELECT
            CustomerNo,
            OrderNo,
            OrderDate,
            ROW_NUMBER() OVER (PARTITION BY CustomerNo ORDER BY OrderDate DESC) AS RowNum
        FROM Manager_Orders_V
    ) ranked
    WHERE RowNum = 1;

**Alternative — `TOP (1) WITH TIES`:**

    SELECT TOP (1) WITH TIES
        CustomerNo, OrderNo, OrderDate
    FROM Manager_Orders_V
    ORDER BY ROW_NUMBER() OVER (PARTITION BY CustomerNo ORDER BY OrderDate DESC);

`WITH TIES` includes all rows that tie for the boundary position. Since `ROW_NUMBER()` is unique per partition, this returns exactly one row per customer.

---

## CROSS APPLY Patterns

`CROSS APPLY` evaluates a table expression once per row from the outer query. It serves three common roles in views.

**Computed columns (DRY calculations):**

    SELECT
        P.ProductNo,
        P.Price,
        calc.Tax,
        calc.Total
    FROM Product P
    CROSS APPLY (
        SELECT
            P.Price * 0.15 AS Tax,
            P.Price * 1.15 AS Total
    ) AS calc
    WHERE calc.Total > 100;

Define the calculation once, reference it in SELECT and WHERE without repeating the expression.

**Unpivoting with VALUES (better than UNPIVOT):**

    SELECT
        S.CustomerNo,
        quarter.Label,
        quarter.Amount
    FROM QuarterlySales S
    CROSS APPLY (
        VALUES
            ('Q1', S.Q1Sales),
            ('Q2', S.Q2Sales),
            ('Q3', S.Q3Sales),
            ('Q4', S.Q4Sales)
    ) AS quarter(Label, Amount)
    WHERE quarter.Amount > 0;

Unlike the `UNPIVOT` operator, `CROSS APPLY VALUES` preserves NULL rows (UNPIVOT silently drops them) and allows mixed types.

**Latest record (already covered in [View Patterns](view-patterns.md)):** `OUTER APPLY` with `TOP 1 ... ORDER BY DESC` fetches the most recent related record while preserving the outer row when no match exists.

---

## String Aggregation

Use `STRING_AGG` to concatenate related rows into a delimited string:

    STRING_AGG(T.TagName, ', ') WITHIN GROUP (ORDER BY T.TagName) AS Tags

Available since SQL Server 2017. Use `WITHIN GROUP (ORDER BY ...)` to control the output order.

**Legacy (SQL Server 2016 and earlier):** use `FOR XML PATH('')` with `STUFF()`:

    STUFF((
        SELECT ', ' + T.TagName
        FROM ProductTag PT
        INNER JOIN Tag T ON PT.TagNo = T.TagNo
        WHERE PT.ProductNo = P.ProductNo
        ORDER BY T.TagName
        FOR XML PATH(''), TYPE
    ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS Tags

---

## Batch Operations

When a procedure must update or delete a large number of rows, do it in chunks to avoid bloating the transaction log and blocking other operations:

    DECLARE @RowsAffected INT = 1;

    WHILE (@RowsAffected > 0)
    BEGIN
        UPDATE TOP (5000) Notification
        SET [Status] = 'Cancelled'
        WHERE [Status] = 'Pending'
            AND ScheduledFor < DATEADD(day, -90, SYSDATETIME());

        SET @RowsAffected = @@ROWCOUNT;
    END

Each iteration is its own implicit transaction (or wrap in an explicit one if atomicity across chunks matters). The chunk size (5000) is tunable — balance between log growth and overhead per iteration.

**When to batch:** any operation that could affect more than ~10,000 rows. The threshold depends on your environment, but the pattern is always the same.

---

## Parameter Sniffing

When a stored procedure runs fast for one parameter value but times out for another, the cause is usually **parameter sniffing** — SQL Server compiled a query plan optimized for the first value, and that plan is terrible for the current value.

**The correct fix — `OPTIMIZE FOR UNKNOWN`:**

    SELECT OrderNo, CustomerNo, OrderDate
    FROM Manager_Orders_V
    WHERE [Status] = @Status
    OPTION (OPTIMIZE FOR (@Status UNKNOWN));

This tells the optimizer to use average distribution statistics instead of the sniffed value. It produces a "safe" generalized plan.

**When to use `OPTION (RECOMPILE)` instead:**

    -- Use when data distribution is highly skewed AND the procedure is called infrequently
    OPTION (RECOMPILE);

This forces a fresh plan every execution. It finds the optimal plan each time but burns CPU on compilation. Use it for infrequent, high-variance queries — not for procedures called hundreds of times per second.

**Do NOT use the local variable copy trick:**

    -- BAD: defeats sniffing entirely, even when sniffing would help
    DECLARE @LocalStatus QueueState = @Status;
    SELECT ... WHERE [Status] = @LocalStatus;

This is an outdated workaround. It masks the parameter from the optimizer, but you lose the benefit of sniffing on the common case too. `OPTIMIZE FOR UNKNOWN` achieves the same effect with explicit intent.

---

## See Also

- [View Patterns](view-patterns.md) — view templates where these query patterns are used
- [Procedure Structure](procedure-structure.md) — the `_trx` / `_utx` templates where batch operations and parameter sniffing fixes apply
- [Relational Queues](relational-queues.md) — the `Next_` procedure where CROSS APPLY and window functions may be useful

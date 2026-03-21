# Pivot & Unpivot


Transforming rows into columns (pivot) and columns into rows (unpivot) for cross-tab reports and data normalization.

## Table of Contents

- [Static PIVOT](#static-pivot)
- [Dynamic PIVOT](#dynamic-pivot)
- [UNPIVOT Operator](#unpivot-operator)
- [CROSS APPLY VALUES Unpivot](#cross-apply-values-unpivot)
- [Multi-Column Unpivot](#multi-column-unpivot)
- [Common Mistakes](#common-mistakes)
- [See Also](#see-also)

---

## Static PIVOT


Use when the column values are known at design time. The PIVOT operator requires three components: an aggregation function, the column to spread, and the list of values to become column headers.[^1]

    -- Quarterly revenue by product
    SELECT ProductName, [Q1], [Q2], [Q3], [Q4]
    FROM (
        SELECT
            P.ProductName,
            'Q' + CAST(DATEPART(quarter, O.OrderDate) AS VARCHAR) AS Qtr,
            O.Revenue
        FROM Sales.Orders O
        JOIN Production.Products P ON P.ProductID = O.ProductID
        WHERE O.OrderDate >= '2024-01-01'
          AND O.OrderDate <  '2025-01-01'
    ) AS Src
    PIVOT (
        SUM(Revenue)
        FOR Qtr IN ([Q1], [Q2], [Q3], [Q4])
    ) AS Pvt
    ORDER BY ProductName;

**Key rules:**

1. The source subquery must contain exactly the columns you want in the output: the row identifier (ProductName), the spread column (Qtr), and the value column (Revenue). Any extra columns become implicit GROUP BY columns and produce unexpected rows.

2. Column values in the IN list must be known at compile time — literals only, no variables.

3. NULLs in the spread column are silently dropped (a row with Qtr = NULL will not appear in any column).

### PIVOT with different aggregations

PIVOT supports only one aggregation function. For multiple aggregations (SUM and COUNT on the same pivot), use conditional aggregation instead:

    SELECT
        ProductName,
        SUM(CASE WHEN Qtr = 'Q1' THEN Revenue END)  AS Q1_Revenue,
        COUNT(CASE WHEN Qtr = 'Q1' THEN 1 END)      AS Q1_Orders,
        SUM(CASE WHEN Qtr = 'Q2' THEN Revenue END)  AS Q2_Revenue,
        COUNT(CASE WHEN Qtr = 'Q2' THEN 1 END)      AS Q2_Orders
    FROM (
        SELECT P.ProductName,
               'Q' + CAST(DATEPART(quarter, O.OrderDate) AS VARCHAR) AS Qtr,
               O.Revenue
        FROM Sales.Orders O
        JOIN Production.Products P ON P.ProductID = O.ProductID
        WHERE YEAR(O.OrderDate) = 2024
    ) AS Src
    GROUP BY ProductName;

---

## Dynamic PIVOT


When the column values are not known until runtime (product names, month names, status codes), build the PIVOT query dynamically.[^5]

    DECLARE @Cols  NVARCHAR(MAX),
            @SQL   NVARCHAR(MAX);

    -- Step 1: Build the column list using STRING_AGG + QUOTENAME[^3]
    SELECT @Cols = STRING_AGG(QUOTENAME(StatusName), ', ')
                   WITHIN GROUP (ORDER BY StatusName)
    FROM (SELECT DISTINCT Status AS StatusName FROM Sales.Orders) AS T;

    -- Step 2: Build the PIVOT query
    SET @SQL = N'
    SELECT Region, ' + @Cols + N'
    FROM (
        SELECT Region, Status, OrderID
        FROM Sales.Orders
    ) AS Src
    PIVOT (
        COUNT(OrderID)
        FOR Status IN (' + @Cols + N')
    ) AS Pvt
    ORDER BY Region;';

    -- Step 3: Execute safely[^4]
    EXEC sp_executesql @SQL;

**Why QUOTENAME matters:** QUOTENAME wraps each value in square brackets and escapes embedded brackets, preventing SQL injection.[^2] A status value like `Robert'; DROP TABLE Sales.Orders; --` becomes `[Robert'; DROP TABLE Sales.Orders; --]` — a harmless column identifier, not executable code. Never concatenate raw user data into the column list without QUOTENAME.

**Pre-2017 column list (STRING_AGG not available):**

    SELECT @Cols = STUFF(
        (SELECT ', ' + QUOTENAME(Status)
         FROM (SELECT DISTINCT Status FROM Sales.Orders) AS T
         ORDER BY Status
         FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'),
        1, 2, ''
    );

STRING_AGG is the default approach since SQL Server 2017.[^6] Use the FOR XML PATH pattern only for backward compatibility.

### Dynamic PIVOT with parameters

To filter the pivoted data, pass parameters through sp_executesql:

    SET @SQL = N'
    SELECT Region, ' + @Cols + N'
    FROM (
        SELECT Region, Status, OrderID
        FROM Sales.Orders
        WHERE OrderDate >= @StartDate AND OrderDate < @EndDate
    ) AS Src
    PIVOT (COUNT(OrderID) FOR Status IN (' + @Cols + N')) AS Pvt
    ORDER BY Region;';

    EXEC sp_executesql @SQL,
        N'@StartDate DATE, @EndDate DATE',
        @StartDate = '2024-01-01',
        @EndDate = '2025-01-01';

---

## UNPIVOT Operator


Converts columns into rows. The built-in UNPIVOT operator is concise but has a critical limitation: it silently drops rows where the value column is NULL.[^1]

    -- Columns to rows: quarterly data
    SELECT ProductID, Quarter, Revenue
    FROM (
        SELECT ProductID, Q1, Q2, Q3, Q4
        FROM Sales.QuarterlyRevenue
    ) AS Src
    UNPIVOT (
        Revenue FOR Quarter IN (Q1, Q2, Q3, Q4)
    ) AS Unpvt;

If product 42 has Q3 = NULL, that row is silently excluded from the result. This is often not the desired behavior in reports — a missing quarter should appear as NULL, not vanish.

---

## CROSS APPLY VALUES Unpivot


The preferred unpivot technique. CROSS APPLY VALUES preserves NULLs, supports mixed types, and is more readable.

    SELECT
        S.ProductID,
        Q.Quarter,
        Q.Revenue
    FROM Sales.QuarterlyRevenue S
    CROSS APPLY (
        VALUES
            ('Q1', S.Q1),
            ('Q2', S.Q2),
            ('Q3', S.Q3),
            ('Q4', S.Q4)
    ) AS Q(Quarter, Revenue);

NULLs in Q3 produce a row with Quarter = 'Q3' and Revenue = NULL — the row is preserved.

**Filtering NULLs when desired:** add a WHERE clause explicitly:

    WHERE Q.Revenue IS NOT NULL

This gives you control — UNPIVOT forces the filtering, CROSS APPLY VALUES lets you choose.

### Including computed values

CROSS APPLY VALUES can include expressions, not just column references:

    CROSS APPLY (
        VALUES
            ('Q1', S.Q1, S.Q1 / NULLIF(S.AnnualTarget, 0) * 100),
            ('Q2', S.Q2, S.Q2 / NULLIF(S.AnnualTarget, 0) * 100),
            ('Q3', S.Q3, S.Q3 / NULLIF(S.AnnualTarget, 0) * 100),
            ('Q4', S.Q4, S.Q4 / NULLIF(S.AnnualTarget, 0) * 100)
    ) AS Q(Quarter, Revenue, PctOfTarget)

---

## Multi-Column Unpivot


When multiple sets of columns need to unpivot together (e.g., both revenue and cost by quarter), CROSS APPLY VALUES handles it naturally:

    SELECT
        S.ProductID,
        Q.Quarter,
        Q.Revenue,
        Q.Cost,
        Q.Revenue - Q.Cost AS Margin
    FROM Sales.QuarterlyResults S
    CROSS APPLY (
        VALUES
            ('Q1', S.Q1Revenue, S.Q1Cost),
            ('Q2', S.Q2Revenue, S.Q2Cost),
            ('Q3', S.Q3Revenue, S.Q3Cost),
            ('Q4', S.Q4Revenue, S.Q4Cost)
    ) AS Q(Quarter, Revenue, Cost);

The UNPIVOT operator cannot do this — it only handles a single value column per operation. To unpivot two column sets with UNPIVOT, you would need two separate UNPIVOT operations and a join, which is verbose and error-prone.

### Mixed-type unpivot

CROSS APPLY VALUES supports different types per row as long as SQL Server can find a common type:

    CROSS APPLY (
        VALUES
            ('Name',    CAST(S.ProductName AS NVARCHAR(200))),
            ('Price',   CAST(S.UnitPrice  AS NVARCHAR(200))),
            ('InStock', CAST(S.InStock    AS NVARCHAR(200)))
    ) AS Attr(AttributeName, AttributeValue)

Cast to a common type (usually NVARCHAR) when mixing strings, numbers, and dates in a single value column.

---

## Common Mistakes


| Mistake | Fix |
|---------|-----|
| Extra columns in PIVOT source subquery | Include only the row identifier, spread column, and value column — extras become implicit GROUP BY columns |
| Using UNPIVOT when NULLs should be preserved | Use CROSS APPLY VALUES instead |
| Concatenating raw values into dynamic PIVOT | Always use QUOTENAME to prevent injection |
| Trying to use variables in static PIVOT IN list | Use dynamic SQL — PIVOT IN requires compile-time literals |
| Using FOR XML PATH for column list on 2017+ | Use STRING_AGG — cleaner and faster |
| Expecting PIVOT to handle multiple aggregations | Use conditional aggregation (CASE inside SUM/COUNT) for multiple metrics |

---

## See Also


- [Aggregation Patterns](aggregation-patterns.md) — conditional aggregation as an alternative to PIVOT
- [Export Patterns](export-patterns.md) — FOR JSON and STRING_AGG for serializing pivoted results
- [Time Series](time-series.md) — date bucketing that often precedes a pivot step

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.


[^1]: [Using PIVOT and UNPIVOT (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/from-using-pivot-and-unpivot) — syntax and examples for PIVOT and UNPIVOT operators including column list requirements and NULL behavior
[^2]: [QUOTENAME (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/quotename-transact-sql) — QUOTENAME wraps identifiers in square brackets and escapes embedded delimiters for constructing valid identifiers in dynamic SQL
[^3]: [STRING_AGG (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/string-agg-transact-sql) — aggregate function for concatenating row values with separator and WITHIN GROUP ordering (SQL Server 2017+)
[^4]: [sp_executesql (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-executesql-transact-sql) — parameterized dynamic SQL execution; preferred over EXEC for plan caching and parameter safety
[^5]: [Creating Dynamic Pivot Table with QUOTENAME Function — CodingSight](https://codingsight.com/creating-dynamic-pivot-table-with-quotename-function/) — end-to-end dynamic PIVOT pattern with QUOTENAME for SQL injection prevention
[^6]: [FOR XML PATH vs STRING_AGG Performance — SQLRx](https://www.sqlrx.com/should-i-replace-my-for-xml-path-string-merges-with-string_agg/) — performance comparison showing STRING_AGG advantage over FOR XML PATH for string aggregation

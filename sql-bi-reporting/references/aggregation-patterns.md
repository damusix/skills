# Aggregation Patterns


Multi-level summaries, conditional counting, and subtotal generation for reporting queries.

## Table of Contents

- [GROUPING SETS](#grouping-sets)
- [ROLLUP](#rollup)
- [CUBE](#cube)
- [Identifying Subtotal Rows](#identifying-subtotal-rows)
- [Conditional Aggregation](#conditional-aggregation)
- [HAVING vs WHERE](#having-vs-where)
- [COUNT Semantics with NULLs](#count-semantics-with-nulls)
- [Common Mistakes](#common-mistakes)
- [See Also](#see-also)

---

## GROUPING SETS


Explicit control over which groupings to compute. Use when you need specific combinations — not all possible ones, and not a strict hierarchy.

    SELECT
        Region,
        ProductCategory,
        SUM(Revenue) AS TotalRevenue
    FROM Sales.Orders
    GROUP BY GROUPING SETS (
        (Region, ProductCategory),   -- detail: region + category
        (Region),                    -- subtotal per region
        (ProductCategory),           -- subtotal per category
        ()                           -- grand total
    );

Each grouping set is an independent aggregation. Columns not in the current grouping set appear as NULL in the result. The query makes a single pass over the data — equivalent to four separate GROUP BY queries combined with UNION ALL, but without scanning the table four times. [^1]

**When to use:** you need exactly these subtotals and nothing more. ROLLUP and CUBE are shortcuts for common GROUPING SETS patterns, but when the shortcut does not match your needs, spell out the sets explicitly.

---

## ROLLUP


Hierarchical subtotals — computes aggregates from the most detailed level up to the grand total, following the column order left to right. ROLLUP(A, B, C) produces these grouping sets: (A, B, C), (A, B), (A), ().

    -- Sales hierarchy: Year > Quarter > Month
    SELECT
        YEAR(OrderDate)    AS OrderYear,
        DATEPART(quarter, OrderDate) AS OrderQuarter,
        MONTH(OrderDate)   AS OrderMonth,
        SUM(TotalAmount)   AS Revenue,
        COUNT(*)           AS OrderCount
    FROM Sales.Orders
    WHERE OrderDate >= '2023-01-01'
      AND OrderDate <  '2025-01-01'
    GROUP BY ROLLUP(
        YEAR(OrderDate),
        DATEPART(quarter, OrderDate),
        MONTH(OrderDate)
    )
    ORDER BY OrderYear, OrderQuarter, OrderMonth;

This produces:
- Detail rows (year + quarter + month)
- Quarterly subtotals (year + quarter, month is NULL)
- Yearly subtotals (year only, quarter and month are NULL)
- Grand total (all three are NULL)

**When to use:** the grouping columns form a natural hierarchy (geography: country > state > city, time: year > quarter > month, org chart: division > department > team). ROLLUP does not produce cross-dimensional combinations — use CUBE or GROUPING SETS for that.

---

## CUBE


All possible combinations of grouping columns. CUBE(A, B) produces: (A, B), (A), (B), (). With three columns, CUBE produces 2^3 = 8 grouping sets.

    -- Revenue by every combination of region and category
    SELECT
        Region,
        ProductCategory,
        SUM(Revenue)    AS TotalRevenue,
        COUNT(*)        AS OrderCount
    FROM Sales.Orders
    GROUP BY CUBE(Region, ProductCategory)
    ORDER BY
        GROUPING(Region),
        GROUPING(ProductCategory),
        Region,
        ProductCategory;

**When to use:** dimensional analysis where you need all cross-cuts — total by region, total by category, total by region + category, and grand total. With more than 3 columns, CUBE produces many grouping sets (2^n) and may return more subtotal rows than needed — switch to GROUPING SETS for precision.

---

## Identifying Subtotal Rows


Subtotal rows have NULLs in the columns not in the current grouping set. But your data might have real NULLs too. Use GROUPING() to distinguish them.

### GROUPING()

Returns 1 when the column value is a subtotal placeholder, 0 when it is a real data value. [^2]

    SELECT
        CASE WHEN GROUPING(Region) = 1
             THEN '(All Regions)'
             ELSE Region
        END AS Region,
        CASE WHEN GROUPING(ProductCategory) = 1
             THEN '(All Categories)'
             ELSE ProductCategory
        END AS ProductCategory,
        SUM(Revenue) AS TotalRevenue
    FROM Sales.Orders
    GROUP BY ROLLUP(Region, ProductCategory);

### GROUPING_ID()

Returns an integer bitmask identifying which columns are aggregated. [^3] Useful for ORDER BY or filtering to specific subtotal levels.

    SELECT
        Region,
        ProductCategory,
        SUM(Revenue)      AS TotalRevenue,
        GROUPING_ID(Region, ProductCategory) AS GrpLevel
    FROM Sales.Orders
    GROUP BY CUBE(Region, ProductCategory)
    ORDER BY GROUPING_ID(Region, ProductCategory), Region, ProductCategory;

GROUPING_ID bit positions (right to left): 0 = detail, 1 = last column aggregated, 2 = second-to-last aggregated. For CUBE(Region, ProductCategory):

| GrpLevel | Region | ProductCategory | Meaning |
|----------|--------|-----------------|---------|
| 0 | data | data | Detail row |
| 1 | data | NULL | Region subtotal |
| 2 | NULL | data | Category subtotal |
| 3 | NULL | NULL | Grand total |

---

## Conditional Aggregation


Use CASE inside an aggregate function to compute filtered metrics in a single pass — no subqueries, no self-joins.

    SELECT
        Region,
        COUNT(*)                                            AS TotalOrders,
        SUM(TotalAmount)                                    AS TotalRevenue,
        SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) AS CompletedOrders,
        SUM(CASE WHEN Status = 'Cancelled' THEN 1 ELSE 0 END) AS CancelledOrders,
        SUM(CASE WHEN Status = 'Completed'
                 THEN TotalAmount ELSE 0 END)               AS CompletedRevenue,
        AVG(CASE WHEN ProductCategory = 'Electronics'
                 THEN TotalAmount END)                       AS AvgElectronicsOrder
    FROM Sales.Orders
    WHERE OrderDate >= '2024-01-01'
      AND OrderDate <  '2025-01-01'
    GROUP BY Region;

**The NULL trick for conditional COUNT:** `COUNT(CASE WHEN condition THEN 1 END)` counts only matching rows. The ELSE is omitted intentionally — it defaults to NULL, and COUNT skips NULLs. This is equivalent to `SUM(CASE WHEN condition THEN 1 ELSE 0 END)` but reads more naturally when counting.

**FILTER syntax:** SQL Server does not support the SQL:2003 `FILTER (WHERE ...)` clause for conditional aggregation. [^5] The CASE-inside-aggregate pattern is the T-SQL equivalent.

### Pivot-style conditional aggregation

    -- Monthly revenue columns without using PIVOT
    SELECT
        ProductCategory,
        SUM(CASE WHEN MONTH(OrderDate) =  1 THEN Revenue END) AS Jan,
        SUM(CASE WHEN MONTH(OrderDate) =  2 THEN Revenue END) AS Feb,
        SUM(CASE WHEN MONTH(OrderDate) =  3 THEN Revenue END) AS Mar,
        SUM(CASE WHEN MONTH(OrderDate) =  4 THEN Revenue END) AS Apr,
        SUM(CASE WHEN MONTH(OrderDate) =  5 THEN Revenue END) AS May,
        SUM(CASE WHEN MONTH(OrderDate) =  6 THEN Revenue END) AS Jun,
        SUM(CASE WHEN MONTH(OrderDate) =  7 THEN Revenue END) AS Jul,
        SUM(CASE WHEN MONTH(OrderDate) =  8 THEN Revenue END) AS Aug,
        SUM(CASE WHEN MONTH(OrderDate) =  9 THEN Revenue END) AS Sep,
        SUM(CASE WHEN MONTH(OrderDate) = 10 THEN Revenue END) AS Oct,
        SUM(CASE WHEN MONTH(OrderDate) = 11 THEN Revenue END) AS Nov,
        SUM(CASE WHEN MONTH(OrderDate) = 12 THEN Revenue END) AS Dec
    FROM Sales.Orders
    WHERE OrderDate >= '2024-01-01'
      AND OrderDate <  '2025-01-01'
    GROUP BY ProductCategory;

This is simpler than PIVOT when you know the column values at design time and want full control over column naming.

---

## HAVING vs WHERE


WHERE filters rows before grouping. HAVING filters groups after aggregation.

    -- WHERE: only 2024 orders are included in the aggregation
    -- HAVING: only regions with revenue over 100K appear in the result
    SELECT
        Region,
        SUM(TotalAmount) AS Revenue
    FROM Sales.Orders
    WHERE OrderDate >= '2024-01-01'
      AND OrderDate <  '2025-01-01'
    GROUP BY Region
    HAVING SUM(TotalAmount) > 100000;

**Rule of thumb:** if you can express the filter in WHERE, do so — it reduces the number of rows entering the GROUP BY, which is always cheaper. Use HAVING only when the filter depends on an aggregate result.

**Common mistake:** using HAVING for non-aggregate conditions.

    -- BAD: Region filter belongs in WHERE, not HAVING
    HAVING Region = 'West' AND SUM(TotalAmount) > 100000

    -- GOOD: filter rows first, then filter groups
    WHERE Region = 'West'
    HAVING SUM(TotalAmount) > 100000

---

## COUNT Semantics with NULLs


This is the most common source of wrong numbers in reports.

| Expression | Counts | NULL behavior |
|-----------|--------|---------------|
| `COUNT(*)` | All rows | Includes NULLs |
| `COUNT(1)` | All rows | Includes NULLs (identical to COUNT(*)) |
| `COUNT(column)` | Non-NULL values in column | Excludes NULLs |
| `COUNT(DISTINCT column)` | Distinct non-NULL values | Excludes NULLs |

    -- 5 orders, 2 have no ShippedDate yet
    SELECT
        COUNT(*)              AS TotalOrders,     -- 5
        COUNT(ShippedDate)    AS ShippedOrders,   -- 3
        COUNT(DISTINCT Status) AS UniqueStatuses   -- excludes NULL status values
    FROM Sales.Orders;

**AVG trap:** AVG computes `SUM(col) / COUNT(col)`, not `SUM(col) / COUNT(*)`. [^4] If NULLs represent zero in your domain, substitute before averaging:

    -- Average including NULLs as zero
    SELECT AVG(ISNULL(Discount, 0)) AS AvgDiscount
    FROM Sales.Orders;

    -- Average excluding NULLs (default behavior)
    SELECT AVG(Discount) AS AvgDiscountExclNull
    FROM Sales.Orders;

**SUM with NULLs:** SUM ignores NULLs. If all values are NULL, SUM returns NULL (not 0). Guard with ISNULL:

    SELECT ISNULL(SUM(Discount), 0) AS TotalDiscount
    FROM Sales.Orders
    WHERE Region = 'Unknown';

---

## Common Mistakes


| Mistake | Fix |
|---------|-----|
| Using HAVING for non-aggregate filters | Move to WHERE — it filters before grouping |
| Expecting COUNT(column) to include NULLs | Use COUNT(*) for total rows |
| Using AVG without considering NULL semantics | Decide if NULLs mean "zero" or "unknown" and use ISNULL accordingly |
| CUBE on too many columns (2^n explosion) | Use GROUPING SETS to specify only the subtotals you need |
| Not labeling subtotal rows | Use GROUPING() or GROUPING_ID() to distinguish real NULLs from subtotal placeholders |
| Repeating the same query for different subtotals | Use ROLLUP/CUBE/GROUPING SETS for a single-pass result |

---

## See Also


- [Pivot & Unpivot](pivot-unpivot.md) — row-to-column transformation as an alternative to conditional aggregation
- [Time Series](time-series.md) — date bucketing and period-over-period comparisons that build on these aggregation patterns
- [Export Patterns](export-patterns.md) — formatting aggregated results as JSON or CSV for downstream consumption

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.


[^1]: [SELECT - GROUP BY (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-group-by-transact-sql) — GROUP BY syntax including ROLLUP, CUBE, and GROUPING SETS clauses with examples
[^2]: [GROUPING (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/grouping-transact-sql) — GROUPING() return value semantics (1 for super-aggregate, 0 for data row) used with ROLLUP, CUBE, and GROUPING SETS
[^3]: [GROUPING_ID (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/grouping-id-transact-sql) — GROUPING_ID() bitmask function for identifying aggregation level in multi-column ROLLUP/CUBE results
[^4]: [Aggregate Functions (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/aggregate-functions-transact-sql) — overview listing all T-SQL aggregate functions; notes that aggregate functions except COUNT(*) ignore NULL values
[^5]: [T-SQL Fundamentals, 4th Edition](https://www.microsoftpressstore.com/store/t-sql-fundamentals-9780138102104) — Itzik Ben-Gan (Microsoft Press, 2023, ISBN 978-0138102104); covers GROUP BY, GROUPING SETS, window functions, and NULL behavior in aggregates

# Export Patterns


Formatting query results for consumption outside SQL Server — JSON documents, XML feeds, CSV strings, bulk file exports, and Power BI DirectQuery.

## Table of Contents

- [FOR JSON PATH](#for-json-path)
- [FOR JSON with Nesting](#for-json-with-nesting)
- [JSON_OBJECT and JSON_ARRAY (2022+)](#json_object-and-json_array-2022)
- [FOR XML PATH](#for-xml-path)
- [STRING_AGG for CSV](#string_agg-for-csv)
- [BCP and BULK INSERT](#bcp-and-bulk-insert)
- [Power BI DirectQuery](#power-bi-directquery)
- [Common Mistakes](#common-mistakes)
- [See Also](#see-also)

---

## FOR JSON PATH


The recommended mode for producing JSON from query results[^1]. Dot-notation aliases control the output structure.

    SELECT
        O.OrderID          AS "id",
        O.OrderDate        AS "orderDate",
        O.TotalAmount      AS "total",
        C.CustomerName     AS "customer.name",
        C.Email            AS "customer.email"
    FROM Sales.Orders O
    JOIN Sales.Customers C ON C.CustomerID = O.CustomerID
    WHERE O.OrderDate >= '2024-01-01'
      AND O.OrderDate <  '2025-01-01'
    FOR JSON PATH, ROOT('orders');

Output:

    {"orders":[
        {"id":1001,"orderDate":"2024-01-15","total":250.00,
         "customer":{"name":"Acme Corp","email":"info@acme.com"}},
        ...
    ]}

**Key options:**

| Option | Effect |
|--------|--------|
| `ROOT('name')` | Wraps the array in a named root object |
| `WITHOUT_ARRAY_WRAPPER` | Returns a single JSON object instead of an array (use for single-row results) |
| `INCLUDE_NULL_VALUES` | Includes properties with null values (default omits them) |

**Avoid FOR JSON AUTO** — its output structure changes silently when you rename aliases or reorder joins. FOR JSON PATH gives you explicit control.

---

## FOR JSON with Nesting


Use correlated subqueries to produce parent-child JSON documents without row duplication.

    SELECT
        C.CustomerID    AS "id",
        C.CustomerName  AS "name",
        (
            SELECT
                O.OrderID     AS "orderId",
                O.OrderDate   AS "date",
                O.TotalAmount AS "total"
            FROM Sales.Orders O
            WHERE O.CustomerID = C.CustomerID
            ORDER BY O.OrderDate DESC
            FOR JSON PATH
        ) AS "orders"
    FROM Sales.Customers C
    WHERE EXISTS (
        SELECT 1 FROM Sales.Orders O
        WHERE O.CustomerID = C.CustomerID
          AND O.OrderDate >= '2024-01-01'
    )
    FOR JSON PATH, ROOT('customers');

The inner FOR JSON PATH returns a JSON array as a property of the outer object. This avoids the row multiplication you would get from a simple JOIN + FOR JSON.

**NULL handling:** when a customer has no orders, the subquery returns NULL. By default, FOR JSON omits the "orders" property entirely. Use INCLUDE_NULL_VALUES if you want `"orders": null` in the output.

---

## JSON_OBJECT and JSON_ARRAY (2022+)


SQL Server 2022 introduced inline JSON constructors[^2] that replace string concatenation patterns.

    -- Build a JSON object from column values
    SELECT JSON_OBJECT(
        'id':     O.OrderID,
        'date':   O.OrderDate,
        'total':  O.TotalAmount,
        'status': O.Status
    ) AS OrderJson
    FROM Sales.Orders O
    WHERE O.OrderID = 1001;

    -- Build a JSON array from scalar values
    SELECT JSON_ARRAY(1, 'two', NULL, 3.14);
    -- [1,"two",null,3.14]

**NULL handling:** JSON_OBJECT includes null properties by default. Use `ABSENT ON NULL` to suppress them:

    SELECT JSON_OBJECT('id': 42, 'email': NULL ABSENT ON NULL);
    -- {"id":42}

JSON_OBJECT and JSON_ARRAY are useful for building individual JSON values in SELECT lists or variable assignments. For full result-set serialization, FOR JSON PATH remains the primary tool.

---

## FOR XML PATH


Use when the downstream system requires XML, or when integrating with SOAP/EDI services[^3].

    SELECT
        O.OrderID       AS "@OrderID",         -- attribute
        O.OrderDate     AS "OrderDate",        -- element
        C.CustomerName  AS "Customer/Name",    -- nested element
        C.Email         AS "Customer/Email"
    FROM Sales.Orders O
    JOIN Sales.Customers C ON C.CustomerID = O.CustomerID
    FOR XML PATH('Order'), ROOT('Orders');

Output:

    <Orders>
      <Order OrderID="1001">
        <OrderDate>2024-01-15T00:00:00</OrderDate>
        <Customer>
          <Name>Acme Corp</Name>
          <Email>info@acme.com</Email>
        </Customer>
      </Order>
    </Orders>

**Nested sub-arrays:** use a correlated subquery with the TYPE directive:

    SELECT
        C.CustomerID AS "@id",
        C.CustomerName AS "Name",
        (
            SELECT O.OrderID AS "@id", O.TotalAmount AS "Amount"
            FROM Sales.Orders O
            WHERE O.CustomerID = C.CustomerID
            FOR XML PATH('Order'), TYPE
        ) AS "Orders"
    FROM Sales.Customers C
    FOR XML PATH('Customer'), ROOT('Customers');

The TYPE directive returns an xml type instead of a string, enabling proper nesting. Without TYPE, the inner XML is string-escaped.

**NULL columns:** FOR XML PATH suppresses elements with NULL values entirely. Use ISNULL or COALESCE to output empty elements when needed.

---

## STRING_AGG for CSV


Concatenate column values into a delimited string[^4] for simple exports or display.

    -- Comma-separated product list per order
    SELECT
        O.OrderID,
        STRING_AGG(P.ProductName, ', ')
            WITHIN GROUP (ORDER BY P.ProductName) AS Products
    FROM Sales.Orders O
    JOIN Sales.OrderDetails D ON D.OrderID = O.OrderID
    JOIN Production.Products P ON P.ProductID = D.ProductID
    GROUP BY O.OrderID;

STRING_AGG is available since SQL Server 2017. Key behaviors:

- Returns NULL when all inputs are NULL
- Output type is NVARCHAR(MAX) — no 4000-character truncation
- WITHIN GROUP (ORDER BY ...) controls output order
- Skips NULL values silently

**Legacy alternative (pre-2017):** STUFF + FOR XML PATH:

    STUFF(
        (SELECT ', ' + P.ProductName
         FROM Sales.OrderDetails D
         JOIN Production.Products P ON P.ProductID = D.ProductID
         WHERE D.OrderID = O.OrderID
         ORDER BY P.ProductName
         FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'),
        1, 2, ''
    ) AS Products

Use STRING_AGG as the default. The FOR XML PATH pattern is a legacy fallback only.

---

## BCP and BULK INSERT


For large-volume exports and imports, use command-line BCP[^5] or T-SQL BULK INSERT.

### BCP export (command line)

    bcp "SELECT OrderID, OrderDate, TotalAmount FROM Sales.Orders" queryout orders.csv -c -t"," -S server -d database -T

| Flag | Meaning |
|------|---------|
| `-c` | Character mode (text output) |
| `-t","` | Field delimiter |
| `-r"\n"` | Row delimiter (default) |
| `-S` | Server name |
| `-d` | Database name |
| `-T` | Trusted connection (Windows auth) |

### BULK INSERT (T-SQL)

    BULK INSERT Sales.StagingOrders
    FROM 'C:\data\orders.csv'
    WITH (
        FIELDTERMINATOR = ',',
        ROWTERMINATOR   = '\n',
        FIRSTROW        = 2,           -- skip header row
        TABLOCK,                       -- table lock for minimal logging[^6]
        BATCHSIZE       = 100000,      -- commit every 100K rows
        ERRORFILE       = 'C:\data\orders_errors.log'
    );

**For columnstore targets:** use BATCHSIZE >= 102400 with TABLOCK to bypass delta stores and write directly to compressed row groups. See the columnstore reference in the mssql-server skill for details.

---

## Power BI DirectQuery


When Power BI uses DirectQuery mode[^7], every visual interaction generates a live T-SQL query against your database. Query performance directly affects dashboard responsiveness.

### Write DirectQuery-friendly SQL

**SARGable filters:** Power BI generates WHERE clauses from slicer selections. Ensure your date and category columns are indexed and that filters hit index seeks, not scans.

    -- Power BI generates this when a user selects a date range
    WHERE OrderDate >= '2024-01-01' AND OrderDate < '2024-04-01'

This is SARGable. But if your view wraps the column in a function:

    -- A view like this defeats Power BI's generated seeks
    WHERE YEAR(OrderDate) = 2024 AND MONTH(OrderDate) BETWEEN 1 AND 3

...then every slicer interaction causes a table scan.

**Avoid scalar UDFs:** scalar user-defined functions in views or queries force row-mode execution, disabling batch-mode processing. Inline the logic or use inline table-valued functions.

**Pre-aggregate where possible:** create indexed views[^8] (materialized views) for common aggregations that Power BI dashboards hit repeatedly.

    CREATE VIEW Sales.DailyRevenue
    WITH SCHEMABINDING
    AS
        SELECT
            CAST(OrderDate AS DATE)  AS SaleDate,
            COUNT_BIG(*)             AS OrderCount,
            SUM(TotalAmount)         AS Revenue
        FROM dbo.Orders
        GROUP BY CAST(OrderDate AS DATE);
    GO

    CREATE UNIQUE CLUSTERED INDEX CIX_DailyRevenue
    ON Sales.DailyRevenue (SaleDate);

Power BI queries against this materialized view hit pre-computed aggregates instead of scanning the full Orders table.

**Keep measures simple:** DirectQuery translates DAX measures to T-SQL. Complex DAX measures with nested CALCULATE/FILTER expressions produce deeply nested subqueries. Where possible, push complexity into SQL views rather than DAX.

### DirectQuery checklist

| Practice | Why |
|----------|-----|
| Index all columns used in slicers | Slicer selections become WHERE predicates |
| Use date columns as DATE type, not DATETIME | Eliminates time-component filtering overhead |
| Avoid views that reference views | Nested view expansion increases query complexity |
| Pre-aggregate in indexed views | Reduces scan volume for common dashboards |
| Test with SSMS before publishing | Run the generated queries with SET STATISTICS IO ON |

---

## Common Mistakes


| Mistake | Fix |
|---------|-----|
| Using FOR JSON AUTO in production | Use FOR JSON PATH — AUTO changes output when aliases change |
| Forgetting TYPE directive in nested FOR XML | Without TYPE, inner XML is string-escaped, not properly nested |
| Using FOR XML PATH for string aggregation on 2017+ | Use STRING_AGG — it is the modern, cleaner approach |
| Wrapping columns in functions in views used by DirectQuery | Keep predicates SARGable — move functions to parameters or computed columns |
| BULK INSERT without TABLOCK on columnstore tables | TABLOCK is required for direct-path loading into compressed row groups |
| JSON_MODIFY without JSON_QUERY for object values | Wrap object/array values with JSON_QUERY to prevent double-escaping |

---

## See Also


- [Aggregation Patterns](aggregation-patterns.md) — the queries that produce the data these export patterns serialize
- [Pivot & Unpivot](pivot-unpivot.md) — reshaping data before export
- [Time Series](time-series.md) — date-based queries often exported to dashboards

---

## Sources

These URLs anchor the claims made above. Do not fetch these links unless you need to verify a specific claim or get deeper detail on a topic.


[^1]: [Format Query Results as JSON with FOR JSON - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/json/format-query-results-as-json-with-for-json-sql-server) — FOR JSON clause reference including PATH and AUTO modes, ROOT, WITHOUT_ARRAY_WRAPPER, and INCLUDE_NULL_VALUES options
[^2]: [JSON_OBJECT (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-object-transact-sql) — JSON_OBJECT inline constructor with NULL ON NULL / ABSENT ON NULL handling (SQL Server 2022+); JSON_ARRAY is documented separately
[^3]: [FOR XML (SQL Server) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/xml/for-xml-sql-server) — FOR XML clause reference including RAW, AUTO, PATH modes and TYPE directive for proper nesting
[^4]: [STRING_AGG (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/functions/string-agg-transact-sql) — aggregate function for concatenating row values into delimited strings (SQL Server 2017+)
[^5]: [bcp Utility - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/tools/bcp-utility) — BCP command-line utility for bulk data export and import with format file support
[^6]: [BULK INSERT (Transact-SQL) - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/bulk-insert-transact-sql) — T-SQL bulk import statement with TABLOCK, FORMAT, error handling, and batch size options
[^7]: [DirectQuery Model Guidance - Power BI | Microsoft Learn](https://learn.microsoft.com/en-us/power-bi/guidance/directquery-model-guidance) — Microsoft's official guidance for optimizing Power BI DirectQuery models against relational data sources (including SQL Server)
[^8]: [Create Indexed Views - SQL Server | Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/views/create-indexed-views) — indexed view (materialized view) requirements, restrictions, and creation steps including COUNT_BIG and SCHEMABINDING rules

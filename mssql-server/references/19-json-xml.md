# JSON and XML in SQL Server

## Table of Contents

1. [When to Use](#when-to-use)
2. [JSON Overview](#json-overview)
3. [FOR JSON](#for-json)
4. [OPENJSON](#openjson)
5. [JSON_VALUE, JSON_QUERY, JSON_MODIFY](#json_value-json_query-json_modify)
6. [JSON Path Expressions](#json-path-expressions)
7. [JSON Indexes and Computed Columns](#json-indexes-and-computed-columns)
8. [JSON Schema Validation (2025+)](#json-schema-validation-2025)
9. [XML Overview](#xml-overview)
10. [FOR XML](#for-xml)
11. [OPENXML](#openxml)
12. [xml Data Type Methods](#xml-data-type-methods)
13. [XQuery in SQL Server](#xquery-in-sql-server)
14. [XML Indexes](#xml-indexes)
15. [JSON vs XML Decision Guide](#json-vs-xml-decision-guide)
16. [Gotchas / Anti-patterns](#gotchas--anti-patterns)
17. [See Also](#see-also)
18. [Sources](#sources)

---

## When to Use

Load this file when the user asks about:
- `FOR JSON`, `OPENJSON`, `JSON_VALUE`, `JSON_QUERY`, `JSON_MODIFY`
- Shredding or building JSON documents in T-SQL
- `FOR XML`, `FOR XML PATH`, `FOR XML AUTO/RAW/EXPLICIT`
- `OPENXML`, `xml` data type, XQuery, `nodes()`, `value()`, `modify()`
- XML indexes (primary and secondary)
- Storing JSON or XML in columns — index strategies
- Converting XML to JSON or vice versa
- REST API integration patterns (building/parsing JSON in SQL)

---

## JSON Overview

SQL Server 2016+ supports JSON natively as a **string format** (no dedicated JSON data type — JSON is stored as `NVARCHAR`). The engine provides:

| Function/Clause | Direction | Purpose |
|---|---|---|
| `FOR JSON` | Rows → JSON | Build JSON from a query result |
| `OPENJSON` | JSON → Rows | Shred JSON into a rowset |
| `JSON_VALUE` | JSON → scalar | Extract a scalar value |
| `JSON_QUERY` | JSON → fragment | Extract an object or array |
| `JSON_MODIFY` | JSON → JSON | Update a value in-place |
| `ISJSON` | JSON → bit | Validate JSON syntax |
| `JSON_PATH_EXISTS` | JSON → bit | Check if a path exists (2022+) |
| `JSON_OBJECT` | → JSON string | Build JSON object from key-value pairs (2022+) |
| `JSON_ARRAY` | → JSON string | Build JSON array from values (2022+) |

> [!NOTE] SQL Server 2022
> `JSON_PATH_EXISTS`, `JSON_OBJECT`, and `JSON_ARRAY` are new in SQL Server 2022 / Azure SQL.

> [!NOTE] SQL Server 2025
> Native `VECTOR` type and dedicated JSON type are SQL Server 2025 features; see `references/52-2025-features.md`.

---

## FOR JSON

### FOR JSON AUTO

The engine infers the JSON structure from the query shape (table aliases define nesting).

```sql
SELECT
    o.OrderID,
    o.OrderDate,
    c.CustomerName,
    c.Email
FROM Orders o
JOIN Customers c ON c.CustomerID = o.CustomerID
WHERE o.OrderID = 1001
FOR JSON AUTO;
```

Result: `Orders` and `Customers` become nested based on the FROM/JOIN order. **Avoid FOR JSON AUTO** in production — the output shape changes silently when you rename aliases or reorder joins.

### FOR JSON PATH (recommended)

Full control over property names and nesting depth via dot-notation aliases.

```sql
SELECT
    o.OrderID          AS "order.id",
    o.OrderDate        AS "order.date",
    c.CustomerName     AS "order.customer.name",
    c.Email            AS "order.customer.email"
FROM Orders o
JOIN Customers c ON c.CustomerID = o.CustomerID
WHERE o.OrderID = 1001
FOR JSON PATH;
```

Output:
```json
[{"order":{"id":1001,"date":"2024-01-15","customer":{"name":"Acme Corp","email":"info@acme.com"}}}]
```

### Key FOR JSON options

```sql
-- Wrap in a root element: {"orders": [...]}
FOR JSON PATH, ROOT('orders');

-- Omit NULLs (default: NULL properties are included as null)
FOR JSON PATH, INCLUDE_NULL_VALUES;   -- force include nulls
-- (omit INCLUDE_NULL_VALUES to suppress null properties — the DEFAULT is omit)

-- Single row result: unwrap the outer array
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;  -- useful for scalar documents
```

### Nesting sub-arrays with subqueries

```sql
SELECT
    c.CustomerID,
    c.CustomerName,
    (
        SELECT o.OrderID, o.OrderDate, o.TotalAmount
        FROM Orders o
        WHERE o.CustomerID = c.CustomerID
        FOR JSON PATH
    ) AS Orders
FROM Customers c
FOR JSON PATH, ROOT('customers');
```

This pattern builds a proper parent/child document without row duplication.

### Aggregating into arrays with STRING_AGG (alternative)

For simple arrays of scalars:

```sql
SELECT
    c.CustomerID,
    '[' + STRING_AGG(CAST(o.OrderID AS NVARCHAR(20)), ',') + ']' AS OrderIDs
FROM Customers c
JOIN Orders o ON o.CustomerID = c.CustomerID
GROUP BY c.CustomerID;
```

---

## OPENJSON

Shreds a JSON string into a rowset. Two modes: **default schema** (key-value pairs) and **explicit schema** (WITH clause).

### Default schema

```sql
DECLARE @json NVARCHAR(MAX) = '{"id":1,"name":"Alice","active":true}';

SELECT [key], value, type
FROM OPENJSON(@json);
-- key    value   type
-- id     1       2  (number)
-- name   Alice   1  (string)
-- active true    3  (boolean)
```

JSON type codes: 0=null, 1=string, 2=number, 3=true/false, 4=array, 5=object.

### Explicit schema (WITH clause) — preferred

```sql
DECLARE @json NVARCHAR(MAX) = N'
[
  {"id":1,"name":"Alice","dept":{"name":"Engineering"},"tags":["sql","python"]},
  {"id":2,"name":"Bob",  "dept":{"name":"Finance"},    "tags":["excel"]}
]';

SELECT *
FROM OPENJSON(@json)
WITH (
    EmployeeID   INT            '$.id',
    EmployeeName NVARCHAR(100)  '$.name',
    Department   NVARCHAR(100)  '$.dept.name',
    TagsRaw      NVARCHAR(MAX)  '$.tags'    AS JSON   -- returns array as JSON string
);
```

The `AS JSON` modifier preserves the value as a JSON fragment instead of converting it to a string scalar.

### Iterating nested arrays

```sql
DECLARE @json NVARCHAR(MAX) = N'
{"orderId":42,"lines":[{"sku":"ABC","qty":2},{"sku":"DEF","qty":5}]}';

SELECT
    j.orderId,
    lines.sku,
    lines.qty
FROM OPENJSON(@json)
    WITH (
        orderId INT      '$.orderId',
        lines   NVARCHAR(MAX) '$.lines' AS JSON
    ) j
CROSS APPLY OPENJSON(j.lines)
    WITH (
        sku NVARCHAR(50) '$.sku',
        qty INT          '$.qty'
    ) lines;
```

### Bulk-loading JSON from a file (2017+)

```sql
SELECT BulkColumn
FROM OPENROWSET(BULK N'C:\data\orders.json', SINGLE_CLOB) AS j;
-- Then pipe into OPENJSON
```

---

## JSON_VALUE, JSON_QUERY, JSON_MODIFY

### JSON_VALUE — extract scalar

```sql
DECLARE @doc NVARCHAR(MAX) = '{"order":{"id":42,"status":"shipped"}}';

SELECT JSON_VALUE(@doc, '$.order.id');       -- '42' (NVARCHAR)
SELECT JSON_VALUE(@doc, '$.order.missing');  -- NULL (lax mode default)
```

Returns `NVARCHAR(4000)`. For values longer than 4000 characters, use `JSON_QUERY` and cast.

### JSON_QUERY — extract object or array

```sql
DECLARE @doc NVARCHAR(MAX) = '{"items":[1,2,3],"meta":{"created":"2024-01-01"}}';

SELECT JSON_QUERY(@doc, '$.items');   -- '[1,2,3]'  (NVARCHAR(MAX) fragment)
SELECT JSON_QUERY(@doc, '$.meta');    -- '{"created":"2024-01-01"}'
```

`JSON_QUERY` returns `NULL` for scalar values (use `JSON_VALUE` for those). Use `JSON_QUERY` when the value is an object or array.

### JSON_MODIFY — update in place

```sql
DECLARE @doc NVARCHAR(MAX) = '{"status":"pending","qty":10}';

-- Update scalar
SET @doc = JSON_MODIFY(@doc, '$.status', 'shipped');

-- Delete a property (set to SQL NULL)
SET @doc = JSON_MODIFY(@doc, '$.qty', NULL);

-- Append to array (use append keyword in path)
DECLARE @arr NVARCHAR(MAX) = '{"tags":["a","b"]}';
SET @arr = JSON_MODIFY(@arr, 'append $.tags', 'c');
-- Result: {"tags":["a","b","c"]}

-- Add a new nested object (value must be typed as JSON)
SET @doc = JSON_MODIFY(@doc, '$.meta', JSON_QUERY('{"source":"api"}'));
```

> **Critical:** When using `JSON_MODIFY` to write an object or array, wrap the value with `JSON_QUERY(...)` to prevent SQL Server from string-escaping the braces/brackets.

### JSON_OBJECT and JSON_ARRAY (2022+)

```sql
-- Build an object inline without string concatenation
SELECT JSON_OBJECT('id':42, 'name':'Alice', 'active':CAST(1 AS BIT));
-- {"id":42,"name":"Alice","active":true}

-- Build an array
SELECT JSON_ARRAY(1, 'two', NULL, JSON_QUERY('{"nested":true}'));
-- [1,"two",null,{"nested":true}]
```

> [!NOTE] SQL Server 2022
> `JSON_OBJECT` and `JSON_ARRAY` replace verbose string concatenation patterns. They handle NULL suppression via `ABSENT ON NULL` / `NULL ON NULL` clauses.

### ISJSON and JSON_PATH_EXISTS

```sql
-- Validate JSON before storing
DECLARE @input NVARCHAR(MAX) = '{"x":1}';
IF ISJSON(@input) = 1
    INSERT INTO JsonStore (Data) VALUES (@input);

-- Check path existence without catching NULL ambiguity (2022+)
SELECT JSON_PATH_EXISTS('{"a":null}', '$.a');  -- 1 (path exists, value is null)
SELECT JSON_PATH_EXISTS('{"a":null}', '$.b');  -- 0 (path missing)
```

> [!NOTE] SQL Server 2022
> `JSON_PATH_EXISTS` disambiguates between "path missing" and "value is null" — something `JSON_VALUE` cannot do (both return NULL).

---

## JSON Path Expressions

| Syntax | Meaning |
|---|---|
| `$` | Root of the document |
| `$.property` | Named property |
| `$.array[0]` | First element of array (0-indexed) |
| `$.a.b.c` | Nested property chain |
| `$.array[*].id` | All `id` values in array (OPENJSON only) |

### Lax vs strict mode

```sql
-- Lax mode (default): missing path returns NULL, no error
SELECT JSON_VALUE('{"a":1}', 'lax $.b');   -- NULL

-- Strict mode: missing path raises error 13608
SELECT JSON_VALUE('{"a":1}', 'strict $.b'); -- Error
```

Use **strict mode** when you need to detect structural mismatches during validation.

---

## JSON Indexes and Computed Columns

SQL Server has no native JSON index type. The pattern is: extract frequently-queried JSON paths into **computed columns**, then index those columns.

```sql
ALTER TABLE Orders ADD
    OrderStatus AS JSON_VALUE(OrderData, '$.status') PERSISTED;

CREATE INDEX IX_Orders_Status ON Orders (OrderStatus)
    WHERE OrderStatus IS NOT NULL;
```

```sql
-- Now this query can use the index:
SELECT OrderID, OrderData
FROM Orders
WHERE JSON_VALUE(OrderData, '$.status') = 'shipped';
-- Optimizer rewrites to: WHERE OrderStatus = 'shipped'
```

> **Important:** The computed column expression must exactly match the `JSON_VALUE` expression in the query (same path, same function, same casing). Any mismatch disables the index.

For range queries on numeric JSON values, cast to the right type in the computed column:

```sql
ALTER TABLE Orders ADD
    OrderAmount AS CAST(JSON_VALUE(OrderData, '$.amount') AS DECIMAL(18,2)) PERSISTED;

CREATE INDEX IX_Orders_Amount ON Orders (OrderAmount);
```

---

## JSON Schema Validation (2025+)

> [!NOTE] SQL Server 2025
> Native JSON schema validation (`ISJSON` with schema parameter) is a SQL Server 2025 / Azure SQL preview feature. The syntax is expected to follow the JSON Schema specification. Use `ISJSON(@doc, 1)` (2016–2022 syntax, validates well-formed JSON only) until 2025 features are GA.

---

## XML Overview

SQL Server has a **native `xml` data type** (not just a string). XML values are stored in an internal binary format and can be queried with XQuery. Maximum size: 2 GB.

```sql
CREATE TABLE Documents (
    DocID   INT PRIMARY KEY,
    Content xml NOT NULL,
    TypedContent xml(DOCUMENT dbo.DocSchema)  -- typed XML bound to XML schema collection
);
```

---

## FOR XML

### FOR XML RAW

Each row becomes a `<row>` element; columns become attributes.

```sql
SELECT OrderID, CustomerID, OrderDate
FROM Orders
FOR XML RAW;
-- <row OrderID="1" CustomerID="10" OrderDate="2024-01-15T00:00:00"/>
```

### FOR XML AUTO

Element names come from table/alias names. Simple but fragile — avoid in production.

```sql
SELECT o.OrderID, c.CustomerName
FROM Orders o
JOIN Customers c ON c.CustomerID = o.CustomerID
FOR XML AUTO;
```

### FOR XML PATH (recommended for production)

Full control over element names and nesting. The empty string `''` alias makes a column an attribute of the parent.

```sql
SELECT
    o.OrderID       AS "@OrderID",        -- attribute
    o.OrderDate     AS "OrderDate",       -- element
    c.CustomerName  AS "Customer/Name",   -- nested element
    c.Email         AS "Customer/Email"
FROM Orders o
JOIN Customers c ON c.CustomerID = o.CustomerID
FOR XML PATH('Order'), ROOT('Orders');
```

Output:
```xml
<Orders>
  <Order OrderID="1">
    <OrderDate>2024-01-15T00:00:00</OrderDate>
    <Customer>
      <Name>Acme Corp</Name>
      <Email>info@acme.com</Email>
    </Customer>
  </Order>
</Orders>
```

### FOR XML EXPLICIT

Maximum control (define each node manually) but extremely verbose. Rarely justified — use `FOR XML PATH` instead.

### FOR XML with sub-queries (nested)

```sql
SELECT
    c.CustomerID    AS "@id",
    c.CustomerName  AS "Name",
    (
        SELECT o.OrderID AS "@id", o.TotalAmount AS "Amount"
        FROM Orders o
        WHERE o.CustomerID = c.CustomerID
        FOR XML PATH('Order'), TYPE
    ) AS "Orders"
FROM Customers c
FOR XML PATH('Customer'), ROOT('Customers');
```

The `TYPE` directive returns an `xml` type instead of a string, enabling proper nesting.

### ELEMENTS directive

Make columns into sub-elements (instead of attributes) in RAW/AUTO/PATH:

```sql
SELECT OrderID, OrderDate
FROM Orders
FOR XML RAW, ELEMENTS;
-- <row><OrderID>1</OrderID><OrderDate>2024-01-15T00:00:00</OrderDate></row>
```

### XMLDATA and XMLSCHEMA (legacy — avoid)

```sql
FOR XML RAW, XMLSCHEMA  -- deprecated inline XDR schema
```

---

## OPENXML

Legacy rowset function for shredding XML. Requires `sp_xml_preparedocument` / `sp_xml_removedocument` for memory management. **Prefer `xml.nodes()` for new code.**

```sql
DECLARE @hdoc INT;
DECLARE @xml NVARCHAR(MAX) = '<Orders><Order id="1" date="2024-01-15"/></Orders>';

EXEC sp_xml_preparedocument @hdoc OUTPUT, @xml;

SELECT *
FROM OPENXML(@hdoc, '/Orders/Order', 1)  -- flag 1 = attribute-centric
WITH (
    id   INT   '@id',
    date DATE  '@date'
);

EXEC sp_xml_removedocument @hdoc;
```

> [!WARNING] Deprecated
> `OPENXML` is a SQL Server 2000-era API. Always call `sp_xml_removedocument` to free the parse tree; leaking the handle causes memory growth. Use `xml.nodes()` / XQuery for new development.

---

## xml Data Type Methods

| Method | Returns | Description |
|---|---|---|
| `.query(xquery)` | `xml` | Evaluate XQuery, return XML fragment |
| `.value(xquery, type)` | SQL scalar | Extract single value with type conversion |
| `.exist(xquery)` | `bit` | 1 if XQuery matches, 0 if not |
| `.nodes(xquery)` | table | Shred XML into rows |
| `.modify(xml_dml)` | void | In-place mutation (INSERT/DELETE/REPLACE VALUE OF) |

### `.value()` — extract scalar

```sql
DECLARE @x xml = '<Order id="42"><Status>Shipped</Status></Order>';

SELECT
    @x.value('(/Order/@id)[1]',      'INT'),          -- 42
    @x.value('(/Order/Status)[1]',   'NVARCHAR(50)'); -- 'Shipped'
```

Always index with `[1]` — `.value()` requires the XQuery expression to return a singleton.

### `.query()` — return XML fragment

```sql
DECLARE @x xml = '<Root><A>1</A><B>2</B></Root>';
SELECT @x.query('/Root/A');  -- returns <A>1</A>
```

### `.exist()` — predicate check

```sql
-- Efficient existence check — can be indexed
SELECT DocID
FROM Documents
WHERE Content.exist('/Invoice/LineItem[@qty > 10]') = 1;
```

### `.nodes()` — shred XML into rows (modern OPENXML replacement)

```sql
DECLARE @x xml = '
<Orders>
  <Order id="1"><Amount>100.00</Amount></Order>
  <Order id="2"><Amount>250.00</Amount></Order>
</Orders>';

SELECT
    o.x.value('@id',        'INT')           AS OrderID,
    o.x.value('Amount[1]',  'DECIMAL(18,2)') AS Amount
FROM @x.nodes('/Orders/Order') AS o(x);
```

The alias `o(x)` gives a column handle `x` representing each matched XML node.

### `.modify()` — in-place XML mutation

```sql
DECLARE @x xml = '<Order><Status>Pending</Status><Items/></Order>';

-- Replace a value
SET @x.modify('replace value of (/Order/Status/text())[1] with "Shipped"');

-- Insert a new element
SET @x.modify('insert <Item sku="ABC" qty="2"/> into (/Order/Items)[1]');

-- Delete a node
SET @x.modify('delete /Order/Items/Item[@sku="ABC"]');
```

`.modify()` uses **XML DML** (a SQL Server extension to XQuery update), not standard XQuery.

---

## XQuery in SQL Server

SQL Server implements a **subset** of XQuery 1.0. Key supported features:

| Feature | Supported |
|---|---|
| FLWOR expressions (for/let/where/order by/return) | Yes (partial) |
| Path expressions | Yes |
| Predicates `[@attr = value]` | Yes |
| Arithmetic and comparison operators | Yes |
| `fn:` functions (count, string, number, etc.) | Partial |
| `sql:column()` and `sql:variable()` | Yes — bind T-SQL values into XQuery |
| Full XQuery Update Facility | No — use `.modify()` instead |

### sql:column() and sql:variable()

```sql
-- Bind a T-SQL column into XQuery
SELECT DocID
FROM Documents
WHERE Content.exist('/Invoice[@custid = sql:column("CustomerID")]') = 1;

-- Bind a T-SQL variable into XQuery
DECLARE @targetSku NVARCHAR(50) = 'ABC-123';
SELECT DocID
FROM Documents
WHERE Content.exist('/Order/Item[@sku = sql:variable("@targetSku")]') = 1;
```

### Common XQuery path syntax

```xpath
/Root/Child              -- absolute path from root
//Item                   -- descendant Item at any depth (expensive — avoid on large docs)
/Order/Item[@qty > 5]    -- predicate filter
/Order/Item[1]           -- first Item (1-indexed in XQuery, unlike JSON's 0-indexed)
/Order/Item[last()]      -- last Item
/Order/*                 -- all child elements of Order
@id                      -- attribute named id
```

---

## XML Indexes

For tables with heavy `xml` column queries, XML indexes dramatically improve performance. An xml column can have **one primary XML index** and up to three types of secondary XML indexes.

### Primary XML index

```sql
-- Requires a clustered PK on the base table
CREATE PRIMARY XML INDEX PXML_Docs_Content
    ON Documents (Content);
```

The primary XML index shreds and persists all XML nodes into a system table. It's large (roughly 1.5–3× the raw XML size) but enables secondary indexes.

### Secondary XML indexes

```sql
-- PATH: speeds up .exist() and .query() with path-based predicates
CREATE XML INDEX IXML_Docs_Path
    ON Documents (Content)
    USING XML INDEX PXML_Docs_Content
    FOR PATH;

-- VALUE: speeds up .value() extraction on known paths
CREATE XML INDEX IXML_Docs_Value
    ON Documents (Content)
    USING XML INDEX PXML_Docs_Content
    FOR VALUE;

-- PROPERTY: speeds up multiple properties from the same node
CREATE XML INDEX IXML_Docs_Prop
    ON Documents (Content)
    USING XML INDEX PXML_Docs_Content
    FOR PROPERTY;
```

**Index selection heuristics:**

| Workload | Best secondary index |
|---|---|
| `.exist('/path')` style filters | PATH |
| `.value('/path', type)` retrieval | VALUE |
| Multiple `.value()` on same element | PROPERTY |
| Mixed workload | All three (storage-permitting) |

---

## JSON vs XML Decision Guide

| Concern | JSON | XML |
|---|---|---|
| Native data type | No (`NVARCHAR`) | Yes (`xml`) |
| Index support | Computed column + regular index | Primary + secondary XML indexes |
| Schema enforcement | None in-engine (2022); validation via `ISJSON` | `xml` schema collections (XSD) |
| Nested array handling | Natural | Verbose |
| Namespace support | N/A | Full XML namespace support |
| XQuery / update facility | No | `.modify()` / XML DML |
| Integration with REST APIs | Preferred | Awkward |
| Integration with SOAP/legacy | Awkward | Preferred |
| Row shredding performance | `OPENJSON` | `xml.nodes()` (faster for large docs) |
| Storage overhead | Lower | Higher (plus index) |

**Recommendation:** Use JSON for REST API patterns, new development, and document storage without schema enforcement. Use XML when you need namespace handling, XML schema validation, or are integrating with legacy SOAP/EDI systems.

---

## Gotchas / Anti-patterns

1. **`JSON_VALUE` returns `NVARCHAR(4000)` max.** For values > 4000 chars, use `JSON_QUERY` and cast explicitly. Silently truncates at 4000 chars with no error.

2. **`FOR JSON AUTO` shape changes silently.** Renaming a table alias or changing join order changes the output structure. Always use `FOR JSON PATH` for documented APIs.

3. **`JSON_MODIFY` with object/array values must use `JSON_QUERY`.** Without it, SQL Server string-escapes the value: `{"meta":"{\"key\":\"value\"}"}` instead of `{"meta":{"key":"value"}}`.

4. **`OPENJSON` default schema returns all values as `NVARCHAR`.** Even numbers and booleans are strings. Always use the `WITH` clause for typed extraction.

5. **`xml.value()` requires a singleton XQuery expression.** If the path can match multiple nodes, `[1]` is required. Omitting it causes a runtime error (not a compile error).

6. **`//` (descendant-or-self) in XQuery is expensive.** It forces a full scan of the XML shredded index. Use absolute paths whenever possible.

7. **`OPENXML` leaks memory if `sp_xml_removedocument` is not called.** Each `sp_xml_preparedocument` call allocates memory in the server's address space. A leaked handle is released only on connection close.

8. **JSON path expressions are case-sensitive.** `$.Status` and `$.status` are different paths. This is especially surprising when data comes from case-insensitive upstream systems.

9. **`FOR XML PATH` with a `NULL` value suppresses the element entirely.** This is often the desired behavior but can cause missing elements in the output. Use `ISNULL(col, '')` or `COALESCE` to include empty elements explicitly.

10. **Large `xml` column values cause plan issues.** The optimizer cannot estimate cardinality inside XML content. For high-cardinality filtering, use persisted computed columns (for common paths) rather than `.exist()` or `.value()` in WHERE clauses without indexes.

11. **`JSON_VALUE` path is lax by default.** A typo in the path returns NULL, not an error. Use `strict` prefix in quality-critical code: `JSON_VALUE(@doc, 'strict $.expectedPath')`.

12. **`FOR XML` with `ELEMENTS XSINIL` adds namespace declarations** that may surprise consumers. Use `ELEMENTS` without `XSINIL` unless you need xsi:nil markers for null elements.

---

## See Also

- `references/03-syntax-dml.md` — OUTPUT clause with JSON/XML pipeline patterns
- `references/06-stored-procedures.md` — passing JSON as NVARCHAR parameter for flexible APIs
- `references/08-indexes.md` — computed column indexes for JSON paths
- `references/23-dynamic-sql.md` — building dynamic WHERE clauses using OPENJSON
- `references/32-performance-diagnostics.md` — diagnosing slow XML/JSON queries
- `references/52-2025-features.md` — SQL Server 2025 native JSON type and vector search

---

## Sources

[^1]: [Format Query Results as JSON with FOR JSON - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/json/format-query-results-as-json-with-for-json-sql-server) — FOR JSON clause reference including PATH and AUTO modes
[^2]: [OPENJSON (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql) — OPENJSON table-valued function for shredding JSON into rows
[^3]: [JSON_VALUE (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-value-transact-sql) — JSON_VALUE scalar extraction; see also JSON_QUERY and JSON_MODIFY references
[^4]: [JSON_OBJECT (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-object-transact-sql) — JSON_OBJECT and JSON_ARRAY constructors (2022+)
[^5]: [JSON_PATH_EXISTS (Transact-SQL) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-path-exists-transact-sql) — JSON_PATH_EXISTS path existence test (2022+)
[^6]: [FOR XML (SQL Server) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/xml/for-xml-sql-server) — FOR XML clause reference including RAW, AUTO, EXPLICIT, and PATH modes
[^7]: [xml Data Type Methods - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/xml/xml-data-type-methods) — xml data type methods (query, value, exist, nodes, modify)
[^8]: [XML Indexes (SQL Server) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/xml/xml-indexes-sql-server) — primary and secondary XML indexes reference
[^9]: [XQuery Language Reference (SQL Server) - SQL Server](https://learn.microsoft.com/en-us/sql/xquery/xquery-language-reference-sql-server) — XQuery language subset supported in SQL Server
[^10]: [T-SQL Fundamentals, 4th Edition](https://www.microsoftpressstore.com/store/t-sql-fundamentals-9780138102104) — Itzik Ben-Gan (Microsoft Press, 2023; ISBN 978-0138102104) — covers T-SQL querying fundamentals for SQL Server 2022 including data modification, table expressions, and set operations; a companion reference for JSON/XML T-SQL patterns.

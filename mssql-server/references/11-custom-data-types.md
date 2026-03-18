# 11 — Custom Data Types

SQL Server offers several mechanisms to define custom or extended data types: alias types (user-defined data types based on system types), table types (used as TVPs and table variables), CLR-based UDTs, spatial types (`geometry`/`geography`), and sparse columns. This file covers all of them with usage guidance and gotchas.

---

## Table of Contents

1. [When to Use Custom Types](#1-when-to-use-custom-types)
2. [Alias Types (UDDTs)](#2-alias-types-uddts)
3. [Table Types and Table-Valued Parameters](#3-table-types-and-table-valued-parameters)
4. [CLR User-Defined Types](#4-clr-user-defined-types)
5. [Spatial Types: geometry and geography](#5-spatial-types-geometry-and-geography)
6. [Sparse Columns](#6-sparse-columns)
7. [Hierarchyid](#7-hierarchyid)
8. [Dropping and Modifying Types](#8-dropping-and-modifying-types)
9. [Querying Type Metadata](#9-querying-type-metadata)
10. [Gotchas / Anti-Patterns](#10-gotchas--anti-patterns)
11. [See Also](#11-see-also)
12. [Sources](#12-sources)

---

## 1. When to Use Custom Types

| Scenario | Recommended approach |
|---|---|
| Enforce consistent column width/nullability across many tables | Alias type (UDDT) |
| Pass structured tabular data to a stored procedure | Table type (TVP) |
| Complex scalar value with methods (point, address) | CLR UDT |
| Geospatial coordinates, distance queries | `geography` / `geometry` |
| Wide table with many NULLable columns (>90% NULL) | Sparse columns |
| Hierarchical paths (org charts, file paths) | `hierarchyid` |

> [!WARNING] Deprecated
> The `CREATE DEFAULT` and `CREATE RULE` objects (bound to alias types via `sp_bindefault`/`sp_bindrule`) are deprecated since SQL Server 2005. Last supported: SQL Server 2019. Use `DEFAULT` constraints and `CHECK` constraints on the column or alias type instead.

---

## 2. Alias Types (UDDTs)

Alias types wrap a system type and can carry a default nullability and a bound `CHECK` rule (via the deprecated rule mechanism) or serve as documentation-level contracts enforced at DDL time.

### Creating an Alias Type

```sql
-- Create an alias for a commonly used type
CREATE TYPE dbo.PhoneNumber FROM NVARCHAR(20) NOT NULL;
CREATE TYPE dbo.EmailAddress FROM NVARCHAR(254) NOT NULL;
CREATE TYPE dbo.ShortCode    FROM CHAR(3)       NOT NULL;
CREATE TYPE dbo.Money2       FROM DECIMAL(18,2) NOT NULL;
```

### Using an Alias Type in a Table

```sql
CREATE TABLE dbo.Customer
(
    CustomerID   INT           NOT NULL IDENTITY(1,1),
    Phone        dbo.PhoneNumber,           -- inherits NVARCHAR(20) NOT NULL
    Email        dbo.EmailAddress NULL,     -- can override nullability at column level
    CountryCode  dbo.ShortCode,
    CONSTRAINT PK_Customer PRIMARY KEY (CustomerID)
);
```

> [!WARNING]
> Nullability override at the column level overrides the type definition. Specifying `NULL` on a column declared as a `NOT NULL` alias type is allowed by the engine — the column will be nullable. Rely on the type's nullability only as a default hint, not a hard constraint.

### Changing a Column's Type After the Fact

You cannot `ALTER TYPE` to change the underlying base type. Instead:

1. Create a new type
2. `ALTER TABLE ... ALTER COLUMN` all dependent columns
3. Drop the old type

---

## 3. Table Types and Table-Valued Parameters

Table types define a named schema for a table variable or TVP. They are stored in the database and must exist before the procedure referencing them is created.

### Creating a Table Type

```sql
CREATE TYPE dbo.OrderLineList AS TABLE
(
    ProductID   INT            NOT NULL,
    Quantity    INT            NOT NULL,
    UnitPrice   DECIMAL(10,2)  NOT NULL,
    UNIQUE (ProductID)   -- allowed; PRIMARY KEY also allowed
);
```

Allowed inside `AS TABLE`:
- Column definitions (with data types, nullability, defaults)
- `PRIMARY KEY` and `UNIQUE` constraints (but not named foreign keys)
- `CHECK` constraints
- `DEFAULT` constraints

Not allowed:
- `FOREIGN KEY` references
- `IDENTITY` columns
- Computed columns

### Using a Table Type as a TVP

```sql
CREATE PROCEDURE dbo.usp_InsertOrderLines
    @OrderID  INT,
    @Lines    dbo.OrderLineList READONLY   -- READONLY is mandatory
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO dbo.OrderLine (OrderID, ProductID, Quantity, UnitPrice)
    SELECT @OrderID, ProductID, Quantity, UnitPrice
    FROM   @Lines;
END;
GO
```

> [!WARNING]
> `READONLY` is required for TVP parameters. You cannot modify a TVP inside the procedure — treat it as an input-only set. [^1]

### Calling with a TVP (T-SQL)

```sql
DECLARE @Lines dbo.OrderLineList;

INSERT INTO @Lines (ProductID, Quantity, UnitPrice)
VALUES (101, 2, 9.99), (102, 1, 24.95);

EXEC dbo.usp_InsertOrderLines
    @OrderID = 5001,
    @Lines   = @Lines;
```

### Calling with a TVP (ADO.NET C#)

```csharp
using var cmd = new SqlCommand("dbo.usp_InsertOrderLines", conn);
cmd.CommandType = CommandType.StoredProcedure;

cmd.Parameters.AddWithValue("@OrderID", 5001);

// DataTable must match the column schema of dbo.OrderLineList
var dt = new DataTable();
dt.Columns.Add("ProductID", typeof(int));
dt.Columns.Add("Quantity",  typeof(int));
dt.Columns.Add("UnitPrice", typeof(decimal));
dt.Rows.Add(101, 2, 9.99m);
dt.Rows.Add(102, 1, 24.95m);

var tvp = cmd.Parameters.AddWithValue("@Lines", dt);
tvp.SqlDbType = SqlDbType.Structured;
tvp.TypeName  = "dbo.OrderLineList";
```

### TVP vs Alternatives

| Mechanism | Cardinality estimate | Parallelism | Schema-bound | ADO.NET support |
|---|---|---|---|---|
| TVP (`dbo.OrderLineList`) | Fixed guess (1 row pre-2019) / deferred compilation 2019+ | Possible | Yes | Yes (`SqlDbType.Structured`) |
| Temp table (`#t`) | Uses statistics from actual inserts | Yes | No | Via normal INSERT |
| JSON string + OPENJSON | No schema enforcement | Limited | No | Pass as NVARCHAR(MAX) |
| XML + OPENXML | No schema enforcement | Limited | No | Pass as XML |

> [!NOTE] SQL Server 2019
> Table variable deferred compilation (`COMPATIBILITY_LEVEL >= 150`) improves TVP cardinality estimates by deferring compilation until the variable is populated. Check `sys.sql_modules.uses_native_compilation` or look for `TableVariableDeferred` in plan XML. [^2]

---

## 4. CLR User-Defined Types

CLR UDTs let you create scalar types backed by .NET assemblies. The classic examples are SQL Server's built-in `geometry`, `geography`, and `hierarchyid` (which are CLR types). Custom CLR UDTs are rarely needed today but are still supported.

### Requirements

1. `TRUSTWORTHY ON` or an assembly signed with a certificate
2. CLR integration enabled (`sp_configure 'clr enabled', 1`)
3. Assembly loaded with `CREATE ASSEMBLY`
4. Type registered with `CREATE TYPE ... EXTERNAL NAME`

### Enable CLR

```sql
EXEC sp_configure 'clr enabled', 1;
RECONFIGURE;
```

> [!WARNING]
> `TRUSTWORTHY ON` weakens the security boundary of the database. Prefer signing assemblies with a certificate and granting `UNSAFE` permission via the certificate. [^3]

### Create a CLR UDT (Skeleton)

```sql
-- Load the assembly DLL (compiled from C#)
CREATE ASSEMBLY SqlPoint
FROM 'C:\Assemblies\SqlPoint.dll'
WITH PERMISSION_SET = SAFE;
GO

-- Register the type
CREATE TYPE dbo.Point
EXTERNAL NAME SqlPoint.[SqlPoint.Point];
GO

-- Use it
CREATE TABLE dbo.Locations (
    LocationID INT  NOT NULL PRIMARY KEY,
    Coord      dbo.Point NULL
);
```

### When to Use CLR UDTs

Use only when:
- Behavior cannot be expressed as T-SQL (e.g., complex binary encoding, network address type)
- The type needs methods callable from T-SQL (e.g., `coord.Distance(other)`)

Avoid for:
- Types that can be represented as alias types or check-constrained columns
- Types that require `UNSAFE` permission (memory access, OS calls)

---

## 5. Spatial Types: geometry and geography

SQL Server ships two built-in CLR spatial types: `geometry` (planar/flat-earth) and `geography` (round-earth/WGS-84). Both expose a rich method surface for construction, measurement, and relationship testing. [^4]

### geometry vs geography

| Characteristic | `geometry` | `geography` |
|---|---|---|
| Coordinate system | Planar (Euclidean) | Round-earth (WGS-84) |
| Unit of measure | User-defined (any unit) | Meters |
| Max polygon area | No limit | < one hemisphere per polygon |
| Use case | Floor plans, CAD, local maps | GPS coordinates, mapping applications |
| SRID default | None required | 4326 (WGS-84 recommended) |

### Creating Spatial Columns

```sql
CREATE TABLE dbo.Store
(
    StoreID    INT            NOT NULL PRIMARY KEY,
    Name       NVARCHAR(100)  NOT NULL,
    Location   geography      NULL,     -- WGS-84 GPS point
    Footprint  geometry       NULL      -- building floor plan
);
```

### Inserting Spatial Data

```sql
-- geography: longitude first, then latitude (WKT standard)
INSERT INTO dbo.Store (StoreID, Name, Location)
VALUES
(1, 'Downtown',  geography::STPointFromText('POINT(-122.3321 47.6062)', 4326)),
(2, 'Eastside',  geography::STPointFromText('POINT(-122.0347 47.6165)', 4326)),
(3, 'Northgate', geography::STGeomFromText ('POINT(-122.3284 47.7077)', 4326));

-- geometry: simple planar point
INSERT INTO dbo.Store (StoreID, Name, Footprint)
VALUES (1, 'Downtown', geometry::STGeomFromText('POLYGON((0 0, 100 0, 100 50, 0 50, 0 0))', 0));
```

> [!WARNING]
> `geography` uses longitude **first**, then latitude — the opposite of many mapping APIs (which use lat/lng). Getting this backwards produces incorrect distances but no error. [^5]

### Common Spatial Methods

```sql
-- Distance between two geography points (returns meters)
SELECT
    a.Name AS StoreA,
    b.Name AS StoreB,
    a.Location.STDistance(b.Location) AS DistanceMeters,
    a.Location.STDistance(b.Location) / 1000.0 AS DistanceKm
FROM  dbo.Store a
CROSS JOIN dbo.Store b
WHERE a.StoreID < b.StoreID;

-- Find all stores within 5 km of a given point
DECLARE @center geography = geography::STPointFromText('POINT(-122.3321 47.6062)', 4326);

SELECT StoreID, Name,
       Location.STDistance(@center) / 1000.0 AS DistanceKm
FROM   dbo.Store
WHERE  Location.STDistance(@center) <= 5000  -- 5000 meters
ORDER  BY Location.STDistance(@center);

-- Check if a point is within a polygon
SELECT StoreID, Name
FROM   dbo.Store
WHERE  Footprint.STContains(geometry::STPointFromText('POINT(50 25)', 0)) = 1;
```

### Spatial Indexes

Spatial data requires a special index type. Standard B-tree indexes cannot index spatial types.

```sql
-- Spatial index on geography column
-- Requires the table to have a PRIMARY KEY
CREATE SPATIAL INDEX SIX_Store_Location
ON dbo.Store (Location)
USING GEOGRAPHY_GRID
WITH (
    GRIDS = (MEDIUM, MEDIUM, MEDIUM, MEDIUM),
    CELLS_PER_OBJECT = 16
);
```

Key spatial index parameters:
- `USING GEOGRAPHY_GRID` or `GEOMETRY_GRID` / `GEOMETRY_AUTO_GRID` (2012+)
- `GRIDS` — tessellation level per tier (LOW/MEDIUM/HIGH per level 1–4)
- `CELLS_PER_OBJECT` — how many cells cover a single object (higher = better for large polygons, more index space)
- `BOUNDING_BOX` — required for `geometry` (not `geography`) to define the extent of your coordinate space

```sql
-- geometry spatial index requires BOUNDING_BOX
CREATE SPATIAL INDEX SIX_Store_Footprint
ON dbo.Store (Footprint)
USING GEOMETRY_GRID
WITH (
    BOUNDING_BOX = (0, 0, 1000, 1000),
    GRIDS = (HIGH, HIGH, MEDIUM, LOW),
    CELLS_PER_OBJECT = 32
);
```

### Useful Spatial Methods Reference

| Method | Returns | Notes |
|---|---|---|
| `STDistance(other)` | FLOAT | Distance in CRS units (meters for geography) |
| `STContains(other)` | BIT | 1 if this geometry contains `other` |
| `STIntersects(other)` | BIT | 1 if geometries overlap |
| `STUnion(other)` | same type | Merge two geometries |
| `STBuffer(distance)` | same type | Expand by distance |
| `STArea()` | FLOAT | Area (m² for geography) |
| `STLength()` | FLOAT | Perimeter/length |
| `STAsText()` | NVARCHAR | WKT representation |
| `STAsBinary()` | VARBINARY | WKB representation |
| `Lat`, `Long` | FLOAT | Point-only accessors (geography) |
| `STX`, `STY` | FLOAT | Point-only accessors (geometry) |

---

## 6. Sparse Columns

Sparse columns are columns optimized for NULL storage. When a column is NULL, it consumes zero space in the data row. This makes sparse columns useful in "wide table" scenarios (EAV-like designs with hundreds of optional attributes).

### Rules and Requirements

- Column must be nullable (`NULL` — not `NOT NULL`)
- Cannot be used with: `ROWGUIDCOL`, `IDENTITY`, `FILESTREAM`, computed columns
- Max columns per table: 30,000 (vs 1,024 for non-sparse) [^6]
- Sparse columns with a column set are accessible via XML

### Creating Sparse Columns

```sql
CREATE TABLE dbo.ProductAttribute
(
    ProductID       INT            NOT NULL,
    AttributeName   NVARCHAR(100)  NOT NULL,
    -- Standard columns
    TextValue       NVARCHAR(500)  SPARSE NULL,
    NumericValue    DECIMAL(18,4)  SPARSE NULL,
    DateValue       DATE           SPARSE NULL,
    FlagValue       BIT            SPARSE NULL,
    -- Column set: provides XML access to all sparse columns
    AllAttributes   XML COLUMN_SET FOR ALL_SPARSE_COLUMNS,
    CONSTRAINT PK_ProductAttribute PRIMARY KEY (ProductID, AttributeName)
);
```

### Inserting and Querying

```sql
-- Insert (only non-NULL values need to be listed)
INSERT INTO dbo.ProductAttribute (ProductID, AttributeName, NumericValue)
VALUES (1, 'Weight', 2.5);

INSERT INTO dbo.ProductAttribute (ProductID, AttributeName, TextValue, FlagValue)
VALUES (1, 'Color', 'Red', 1);

-- SELECT individual sparse columns normally
SELECT ProductID, AttributeName, TextValue, NumericValue
FROM   dbo.ProductAttribute
WHERE  ProductID = 1;

-- SELECT via column set (returns XML of non-NULL sparse columns)
SELECT ProductID, AllAttributes
FROM   dbo.ProductAttribute
WHERE  ProductID = 1;
```

### Sparse Column Storage Savings

NULL storage cost comparison:

| Column type | NULL storage (per row) | Non-NULL storage |
|---|---|---|
| Regular nullable column | 2 bytes (null bitmap) | Data size |
| Sparse column | 0 bytes | 4 bytes overhead + data size |

> Break-even threshold: if a column is NULL more than ~20–40% of the time (depending on data type), sparse saves space. Microsoft's guidance: sparse pays off when NULL density is ≥ 64% for most types. [^7]

> [!WARNING]
> Sparse columns incur CPU overhead for NULL checking and cannot be indexed with a standard index unless combined with a filtered index (`WHERE col IS NOT NULL`). Avoid sparse on frequently-queried non-NULL columns.

---

## 7. Hierarchyid

`hierarchyid` is a compact, built-in CLR scalar type for storing hierarchical positions (org charts, folder trees, BOMs). It encodes a path like `/1/2/3/` in a variable-length binary format.

### Creating a Hierarchyid Table

```sql
CREATE TABLE dbo.OrgChart
(
    NodeID      hierarchyid     NOT NULL PRIMARY KEY,
    NodeLevel   AS NodeID.GetLevel() PERSISTED,  -- computed for index
    EmployeeID  INT             NOT NULL UNIQUE,
    Name        NVARCHAR(100)   NOT NULL,
    Title       NVARCHAR(100)   NULL
);

-- Depth-first index: good for subtree queries
CREATE UNIQUE INDEX IX_OrgChart_DepthFirst
ON dbo.OrgChart (NodeID);

-- Breadth-first index: good for "all employees at level N" queries
CREATE UNIQUE INDEX IX_OrgChart_BreadthFirst
ON dbo.OrgChart (NodeLevel, NodeID);
```

### Inserting Nodes

```sql
-- Root node
INSERT INTO dbo.OrgChart (NodeID, EmployeeID, Name, Title)
VALUES (hierarchyid::GetRoot(), 1, 'Alice', 'CEO');

-- Child of root
DECLARE @root hierarchyid = hierarchyid::GetRoot();
DECLARE @child1 hierarchyid = @root.GetDescendant(NULL, NULL);
INSERT INTO dbo.OrgChart (NodeID, EmployeeID, Name, Title)
VALUES (@child1, 2, 'Bob', 'VP Engineering');

-- Second child of root (after Bob)
DECLARE @child2 hierarchyid = @root.GetDescendant(@child1, NULL);
INSERT INTO dbo.OrgChart (NodeID, EmployeeID, Name, Title)
VALUES (@child2, 3, 'Carol', 'VP Sales');

-- Child of Bob
DECLARE @bobNode hierarchyid = (SELECT NodeID FROM dbo.OrgChart WHERE EmployeeID = 2);
DECLARE @bobChild hierarchyid = @bobNode.GetDescendant(NULL, NULL);
INSERT INTO dbo.OrgChart (NodeID, EmployeeID, Name, Title)
VALUES (@bobChild, 4, 'Dave', 'Senior Engineer');
```

### Querying the Hierarchy

```sql
-- All employees, indented
SELECT
    REPLICATE('  ', NodeID.GetLevel()) + Name AS IndentedName,
    NodeID.ToString()                          AS Path,
    NodeID.GetLevel()                          AS Depth,
    Title
FROM  dbo.OrgChart
ORDER BY NodeID;  -- depth-first order

-- Subtree of Bob (all reports, direct and indirect)
DECLARE @bob hierarchyid = (SELECT NodeID FROM dbo.OrgChart WHERE EmployeeID = 2);
SELECT Name, Title, NodeID.ToString() AS Path
FROM   dbo.OrgChart
WHERE  NodeID.IsDescendantOf(@bob) = 1
ORDER  BY NodeID;

-- Direct reports only (children at exactly level+1)
SELECT c.Name, c.Title
FROM   dbo.OrgChart p
JOIN   dbo.OrgChart c ON c.NodeID.GetAncestor(1) = p.NodeID
WHERE  p.EmployeeID = 2;

-- Path from node to root
SELECT Name, NodeID.GetAncestor(NodeID.GetLevel() - n.n).ToString() AS AncestorPath
FROM   dbo.OrgChart
CROSS APPLY (VALUES (0),(1),(2),(3),(4),(5)) n(n)
WHERE  EmployeeID = 4
  AND  n.n <= NodeID.GetLevel();
```

### Key hierarchyid Methods

| Method | Description |
|---|---|
| `hierarchyid::GetRoot()` | Static: returns root node `/` |
| `GetDescendant(child1, child2)` | New child between child1 and child2 (pass NULL for bounds) |
| `GetAncestor(n)` | Ancestor n levels up |
| `GetLevel()` | Depth (0 = root) |
| `IsDescendantOf(ancestor)` | 1 if self is in ancestor's subtree (inclusive) |
| `GetReparentedValue(oldRoot, newRoot)` | Move subtree |
| `ToString()` | Human-readable path (`/1/2/3/`) |
| `Parse('/1/2/')` | Static: parse from string |

> [!NOTE]
> `IsDescendantOf` is inclusive — a node is considered a descendant of itself. Use `WHERE NodeID.IsDescendantOf(@bob) = 1 AND NodeID <> @bob` to exclude the root of the subtree.

### hierarchyid vs Adjacency List vs Recursive CTE

| Approach | Subtree query | Insert | Move subtree | Storage |
|---|---|---|---|---|
| `hierarchyid` | Single range seek (with index) | O(siblings) for `GetDescendant` | `GetReparentedValue` on subtree | Compact binary |
| Adjacency list (ParentID) | Recursive CTE, multiple scans | O(1) | Single UPDATE | Simple INT |
| Nested sets (left/right) | Range query | O(N) renumbering | O(N) renumbering | Two INT columns |

`hierarchyid` is the best choice when subtree and ancestor queries dominate and you need compact storage. Use adjacency list when your tree is highly dynamic or when recursive CTE performance is acceptable.

---

## 8. Dropping and Modifying Types

You cannot modify a type definition in place (no `ALTER TYPE ... AS TABLE`). To change a type:

### Changing an Alias Type

```sql
-- Step 1: Create new type
CREATE TYPE dbo.PhoneNumberV2 FROM NVARCHAR(30) NOT NULL;

-- Step 2: Alter all dependent columns (requires knowing them)
SELECT
    OBJECT_NAME(c.object_id) AS TableName,
    c.name AS ColumnName
FROM  sys.columns c
JOIN  sys.types t ON c.user_type_id = t.user_type_id
WHERE t.name = 'PhoneNumber';

-- Step 3: For each table, ALTER COLUMN type
ALTER TABLE dbo.Customer ALTER COLUMN Phone dbo.PhoneNumberV2;

-- Step 4: Drop old type
DROP TYPE dbo.PhoneNumber;
```

### Dropping a Type with Dependencies

```sql
-- Check dependencies before dropping
SELECT
    OBJECT_NAME(object_id) AS DependentObject,
    type_desc
FROM  sys.sql_expression_dependencies
WHERE referenced_entity_name = 'OrderLineList'
  AND referenced_class_desc  = 'TYPE';

-- Find stored procedures, functions, and tables using the type
SELECT DISTINCT
    OBJECT_NAME(p.object_id) AS ProcedureName
FROM  sys.parameters p
JOIN  sys.types t ON p.user_type_id = t.user_type_id
WHERE t.name = 'OrderLineList';
```

The engine will raise an error if you `DROP TYPE` while any procedure, table, or column references it.

> [!WARNING]
> Dropping a table type does not automatically invalidate cached query plans for procedures that use it. After dropping and recreating a table type with a different schema, execute `sp_recompile` on all dependent procedures or use `EXEC sys.sp_refreshsqlmodule`.

---

## 9. Querying Type Metadata

```sql
-- All user-defined types in the current database
SELECT
    t.name                        AS TypeName,
    s.name                        AS SchemaName,
    CASE t.is_table_type
        WHEN 1 THEN 'TABLE TYPE'
        WHEN 0 THEN 'ALIAS TYPE'
    END                           AS Kind,
    bt.name                       AS BaseType,
    t.max_length,
    t.precision,
    t.scale,
    t.is_nullable,
    t.is_assembly_type
FROM  sys.types t
JOIN  sys.schemas s  ON t.schema_id = s.schema_id
LEFT  JOIN sys.types bt ON t.system_type_id = bt.user_type_id
                        AND bt.is_user_defined = 0
WHERE t.is_user_defined = 1
ORDER BY s.name, t.name;

-- Columns in a table type
SELECT
    c.column_id,
    c.name,
    tp.name AS DataType,
    c.max_length,
    c.precision,
    c.scale,
    c.is_nullable
FROM  sys.table_types tt
JOIN  sys.columns c ON c.object_id = tt.type_table_object_id
JOIN  sys.types tp  ON c.user_type_id = tp.user_type_id
WHERE tt.name = 'OrderLineList';

-- Find all procedures using a given table type
SELECT DISTINCT
    OBJECT_NAME(p.object_id) AS ProcedureName,
    p.name                   AS ParameterName
FROM  sys.parameters p
JOIN  sys.types t ON p.user_type_id = t.user_type_id
WHERE t.name = 'OrderLineList';

-- Spatial indexes
SELECT
    i.name            AS IndexName,
    OBJECT_NAME(i.object_id) AS TableName,
    i.type_desc,
    s.tessellation_scheme,
    s.level_1_grid_desc,
    s.level_2_grid_desc,
    s.cells_per_object
FROM  sys.spatial_indexes i
JOIN  sys.spatial_index_tessellations s ON i.object_id = s.object_id
                                        AND i.index_id = s.index_id;
```

---

## 10. Gotchas / Anti-Patterns

1. **Alias types don't enforce length at the procedure level.** A parameter declared as `dbo.PhoneNumber` in a stored procedure does NOT prevent callers from passing a longer string — truncation happens only at insert time. Use `CHECK` constraints on the base table column.

2. **TVPs are READONLY — you cannot declare output TVPs.** If you need to return tabular data, use a temp table, an output cursor (avoid), or return a result set.

3. **Table types don't support `FOREIGN KEY` constraints.** If your TVP needs referential integrity, validate inside the procedure with an `EXISTS` check.

4. **Dropping a table type while a procedure is in the plan cache does not immediately break the cached plan.** The plan will fail the next time it tries to recompile. Proactively `sp_recompile` after dropping.

5. **`geography` hemisphere limit.** A single `geography` polygon cannot span more than one hemisphere (>~20,000 km edge). Wrap-around coordinates (e.g., date line crossing) require careful construction with `ReorientObject()` or splitting geometries. [^8]

6. **Spatial indexes are not used for `STDistance` < threshold queries without a covering index.** The optimizer can use a spatial index for `STDistance(p) <= @dist` when combined with a filter, but not for `ORDER BY STDistance(p) LIMIT n`-style queries — those require scanning.

7. **Sparse columns and `COLUMN_SET`.** Once a `COLUMN_SET` column is added to a table, `SELECT *` returns the column set (XML) instead of individual sparse columns. Existing queries that relied on `SELECT *` will change behavior. Always use explicit column lists.

8. **`hierarchyid.GetDescendant(NULL, NULL)` called concurrently produces non-unique values.** In concurrent insert scenarios, use a lock or sequence-based approach to generate unique sibling positions, or use a serialized insert with `SELECT MAX(NodeID)` under a transaction.

9. **CLR types require assembly reload after SQL Server upgrades.** If `clr strict security` is enabled (default since SQL Server 2017), assemblies must be signed and the signing certificate imported before CLR UDTs work. [^9]

10. **`IDENTITY` is not allowed on table type columns.** If you need an auto-incrementing surrogate in a TVP, generate it in the application or use `ROW_NUMBER()` in the procedure body.

---

## 11. See Also

- [`references/01-syntax-ddl.md`](./01-syntax-ddl.md) — `CREATE TABLE`, schemas, sequences, synonyms
- [`references/06-stored-procedures.md`](./06-stored-procedures.md) — TVP parameters in stored procedures, `READONLY`
- [`references/07-functions.md`](./07-functions.md) — Table-valued functions, scalar UDF inlining
- [`references/12-custom-defaults-rules.md`](./12-custom-defaults-rules.md) — `CHECK` constraints, `DEFAULT` constraints, cascades
- [`references/21-graph-tables.md`](./21-graph-tables.md) — Node/edge tables as alternative to `hierarchyid` for complex graph traversals

---

## Sources

[^1]: [Use table-valued parameters (Database Engine) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-table-valued-parameters-database-engine) — covers TVP declaration, READONLY requirement, permissions, and limitations
[^2]: [Intelligent Query Processing Details - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/performance/intelligent-query-processing-details#table-variable-deferred-compilation) — covers table variable deferred compilation (compatibility level 150+) and how it improves cardinality estimates
[^3]: [CLR Integration Code Access Security - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/clr-integration/security/clr-integration-code-access-security) — covers SAFE/EXTERNAL_ACCESS/UNSAFE permission sets, TRUSTWORTHY risks, and clr strict security
[^4]: [Spatial Data (SQL Server)](https://learn.microsoft.com/en-us/sql/relational-databases/spatial/spatial-data-sql-server) — overview of geometry and geography CLR data types in SQL Server
[^5]: [Point (geography Data Type) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/spatial-geography/point-geography-data-type) — shows that the Point() method takes (Lat, Long, SRID) order, while OGC WKT format uses longitude-first ordering as shown in the [geography instances examples](https://learn.microsoft.com/en-us/sql/relational-databases/spatial/create-construct-and-query-geography-instances)
[^6]: [Use Sparse Columns - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns) — covers sparse column rules, max column limits, restrictions, and storage characteristics
[^7]: [Use Sparse Columns - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns) — includes the NULL percentage break-even table by data type; shows 64% threshold for int columns at the 40% space savings mark
[^8]: [ReorientObject (geography Data Type) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/spatial-geography/reorientobject-geography-data-type) — documents ReorientObject() for correcting hemisphere-spanning polygons in geography instances
[^9]: [Server Configuration: clr strict security - SQL Server](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/clr-strict-security) — documents clr strict security option (enabled by default since SQL Server 2017), requiring signed assemblies for CLR UDTs

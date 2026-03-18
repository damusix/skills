# SQL Server Graph Tables

Graph extensions for SQL Server: node and edge tables, MATCH syntax, SHORTEST_PATH, multi-hop traversal, and comparison with recursive CTEs.

> [!NOTE] SQL Server 2017
> Graph tables (node/edge tables, MATCH) were introduced in SQL Server 2017 (compatibility level 140+).

> [!NOTE] SQL Server 2019
> SHORTEST_PATH and LAST_NODE/LAST_EDGE were added in SQL Server 2019.

---

## Table of Contents

1. [When to Use Graph Tables](#1-when-to-use-graph-tables)
2. [Graph Concepts Overview](#2-graph-concepts-overview)
3. [Creating Node Tables](#3-creating-node-tables)
4. [Creating Edge Tables](#4-creating-edge-tables)
5. [Inserting Graph Data](#5-inserting-graph-data)
6. [MATCH Syntax](#6-match-syntax)
7. [Multi-Hop Traversal](#7-multi-hop-traversal)
8. [SHORTEST_PATH](#8-shortest_path)
9. [LAST_NODE and LAST_EDGE](#9-last_node-and-last_edge)
10. [Edge Constraints (2019+)](#10-edge-constraints-2019)
11. [Graph vs Recursive CTE Trade-offs](#11-graph-vs-recursive-cte-trade-offs)
12. [Querying Graph Metadata](#12-querying-graph-metadata)
13. [Indexes on Graph Tables](#13-indexes-on-graph-tables)
14. [Gotchas and Anti-patterns](#14-gotchas-and-anti-patterns)
15. [See Also](#15-see-also)
16. [Sources](#sources)

---

## 1. When to Use Graph Tables

Use graph tables when your data has **many-to-many relationships that themselves carry data**, especially when:

- Relationship cardinality is high and dynamic (social networks, knowledge graphs, org hierarchies with lateral connections)
- You need **multi-hop path traversal** without knowing depth ahead of time
- You need **shortest path** between two entities
- Edges carry their own attributes (weight, timestamp, type)
- The alternative is a deeply nested self-join or a complex recursive CTE

**Prefer recursive CTEs** (see [`04-ctes.md`](04-ctes.md)) when:

- The graph is a simple tree (parent-child hierarchy) with a bounded depth
- You already have adjacency-list tables and don't want to migrate
- You need complex aggregations or early termination that MATCH/SHORTEST_PATH doesn't support
- You're on SQL Server 2016 or earlier

**Do not use graph tables** as a general-purpose workaround for missing relational features. Graph extensions are purpose-built for graph traversal — for anything else, the relational model is simpler and faster.

---

## 2. Graph Concepts Overview

| Concept | Meaning | T-SQL keyword |
|---|---|---|
| Node | Entity (person, product, location) | `AS NODE` |
| Edge | Directed relationship between two nodes | `AS EDGE` |
| Graph ID | System-generated opaque identity for nodes/edges | `$node_id`, `$edge_id` |
| From node | Source of an edge | `$from_id` |
| To node | Target of an edge | `$to_id` |
| Pattern | Path expression in a query | `MATCH(...)` |
| SHORTEST_PATH | BFS to find minimum-hop route | `SHORTEST_PATH(...)` |

SQL Server graph tables are stored as ordinary tables. `AS NODE` and `AS EDGE` are syntactic sugar that adds hidden system columns ($node_id, $from_id, $to_id) and enables MATCH syntax. You can still use all normal T-SQL against them.

---

## 3. Creating Node Tables

```sql
-- Simple node table
CREATE TABLE dbo.Person (
    PersonId    INT           NOT NULL PRIMARY KEY,
    Name        NVARCHAR(200) NOT NULL,
    City        NVARCHAR(100) NULL
) AS NODE;

CREATE TABLE dbo.Product (
    ProductId   INT           NOT NULL PRIMARY KEY,
    ProductName NVARCHAR(200) NOT NULL,
    Category    NVARCHAR(100) NULL
) AS NODE;

CREATE TABLE dbo.Company (
    CompanyId   INT           NOT NULL PRIMARY KEY,
    CompanyName NVARCHAR(200) NOT NULL
) AS NODE;
```

Node tables get a hidden `$node_id` column (a JSON string like `{"type":"node","schema":"dbo","table":"Person","id":1}`). You never write to `$node_id` directly — it's auto-generated on INSERT.

To inspect the hidden columns:

```sql
SELECT name, is_hidden, graph_type_desc
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.Person');
-- Shows: $node_id (hidden), PersonId, Name, City
```

---

## 4. Creating Edge Tables

```sql
-- Edge with no attributes (bare relationship)
CREATE TABLE dbo.Knows (
    /* no user columns needed */
) AS EDGE;

-- Edge with attributes
CREATE TABLE dbo.Purchased (
    PurchaseDate DATE          NOT NULL,
    Quantity     INT           NOT NULL DEFAULT 1,
    Amount       DECIMAL(10,2) NOT NULL
) AS EDGE;

-- Edge between specific node types (edge constraints, 2019+)
CREATE TABLE dbo.WorksAt (
    StartDate DATE NOT NULL,
    Role      NVARCHAR(100) NULL,
    CONSTRAINT EC_WorksAt_Person_Company
        CONNECTION (dbo.Person TO dbo.Company)
) AS EDGE;
```

Edge tables get hidden `$edge_id`, `$from_id`, and `$to_id` columns. The `$from_id` and `$to_id` store the `$node_id` values of the connected nodes as JSON.

---

## 5. Inserting Graph Data

```sql
-- Insert nodes (use regular INSERT — $node_id is auto-generated)
INSERT INTO dbo.Person (PersonId, Name, City)
VALUES (1, 'Alice', 'Seattle'),
       (2, 'Bob',   'Portland'),
       (3, 'Carol', 'Seattle'),
       (4, 'Dave',  'San Francisco');

INSERT INTO dbo.Company (CompanyId, CompanyName)
VALUES (100, 'Contoso'),
       (101, 'Fabrikam');

-- Insert edges — reference $node_id using subqueries
INSERT INTO dbo.Knows ($from_id, $to_id)
SELECT p1.$node_id, p2.$node_id
FROM   dbo.Person p1, dbo.Person p2
WHERE  (p1.PersonId = 1 AND p2.PersonId = 2)  -- Alice knows Bob
    OR (p1.PersonId = 2 AND p2.PersonId = 3)  -- Bob knows Carol
    OR (p1.PersonId = 3 AND p2.PersonId = 4); -- Carol knows Dave

INSERT INTO dbo.WorksAt ($from_id, $to_id, StartDate, Role)
SELECT p.$node_id, c.$node_id, '2022-01-15', 'Engineer'
FROM   dbo.Person p, dbo.Company c
WHERE  p.PersonId = 1 AND c.CompanyId = 100;  -- Alice works at Contoso
```

> **Gotcha:** You cannot use the integer PK directly in `$from_id`/`$to_id`. You must resolve the `$node_id` from the node table at insert time.

---

## 6. MATCH Syntax

MATCH is the pattern-matching clause for graph traversal. It goes in the WHERE clause and references aliases defined in FROM.

### Basic one-hop pattern

```sql
-- Who does Alice know?
SELECT p2.Name AS KnownPerson
FROM   dbo.Person     p1,
       dbo.Knows      k,
       dbo.Person     p2
WHERE  MATCH(p1-(k)->p2)
  AND  p1.Name = 'Alice';
```

Pattern syntax: `node-(edge)->node` for directed traversal. Use `<-` for reverse direction, or `<-edge-` notation.

### Multiple patterns in one MATCH (AND semantics)

```sql
-- Friends-of-friends who both know Bob
SELECT p1.Name AS FriendA,
       p3.Name AS FriendB
FROM   dbo.Person p1,
       dbo.Knows  k1,
       dbo.Person p2,
       dbo.Knows  k2,
       dbo.Person p3
WHERE  MATCH(p1-(k1)->p2 AND p3-(k2)->p2)
  AND  p2.Name = 'Bob'
  AND  p1.PersonId <> p3.PersonId;
```

Multiple patterns in a single MATCH are joined (AND). All node aliases must appear in FROM.

### Reverse traversal

```sql
-- Who reports to a manager? (if edge goes manager->report)
SELECT e.Name AS Employee
FROM   dbo.Person m,
       dbo.ReportsTo r,
       dbo.Person e
WHERE  MATCH(m-(r)->e)
  AND  m.Name = 'Alice';

-- Or traverse the same edge backwards:
SELECT m.Name AS Manager
FROM   dbo.Person m,
       dbo.ReportsTo r,
       dbo.Person e
WHERE  MATCH(e<-(r)-m)
  AND  e.Name = 'Bob';
```

### Edge attributes in MATCH results

```sql
-- When did Alice buy something, and what amount?
SELECT pr.ProductName,
       pu.PurchaseDate,
       pu.Amount
FROM   dbo.Person    p,
       dbo.Purchased pu,
       dbo.Product   pr
WHERE  MATCH(p-(pu)->pr)
  AND  p.Name = 'Alice';
```

---

## 7. Multi-Hop Traversal

Before SQL Server 2019, multi-hop required repeated joins (one per hop). This is verbose and requires knowing the depth.

### Fixed-depth traversal (2017+)

```sql
-- 2 hops: who does Alice's friends know?
SELECT p3.Name AS FriendOfFriend
FROM   dbo.Person p1,
       dbo.Knows  k1,
       dbo.Person p2,
       dbo.Knows  k2,
       dbo.Person p3
WHERE  MATCH(p1-(k1)->p2-(k2)->p3)
  AND  p1.Name = 'Alice'
  AND  p3.PersonId <> p1.PersonId;
```

MATCH supports chained patterns: `(n1-(e1)->n2-(e2)->n3)` in a single MATCH. All intermediate aliases must be in FROM.

### Variable-depth traversal (2019+ with SHORTEST_PATH)

See [Section 8](#8-shortest_path) for arbitrary-depth traversal.

---

## 8. SHORTEST_PATH

> [!NOTE] SQL Server 2019
> SHORTEST_PATH was introduced in SQL Server 2019.

SHORTEST_PATH finds the minimum-hop path between a source and any reachable target using BFS internally.

### Basic SHORTEST_PATH

```sql
-- Find shortest path from Alice to all reachable people
SELECT src.Name                              AS Source,
       STRING_AGG(via.Name, ' -> ')
           WITHIN GROUP (GRAPH PATH)        AS Path,
       LAST_VALUE(via.Name)
           WITHIN GROUP (GRAPH PATH)        AS Destination,
       COUNT(via.PersonId)
           WITHIN GROUP (GRAPH PATH)        AS HopsCount
FROM   dbo.Person src,
       dbo.Knows  FOR PATH k,
       dbo.Person FOR PATH via
WHERE  MATCH(SHORTEST_PATH(src-(k->via)+))
  AND  src.Name = 'Alice';
```

Key syntax elements:

| Element | Purpose |
|---|---|
| `FOR PATH` | Required alias modifier on edge and intermediate node tables |
| `SHORTEST_PATH(...)` | Wraps the pattern; `+` means 1 or more hops |
| `STRING_AGG(...) WITHIN GROUP (GRAPH PATH)` | Aggregates values along the path |
| `LAST_VALUE(...) WITHIN GROUP (GRAPH PATH)` | Gets the value at the destination node |
| `COUNT(...) WITHIN GROUP (GRAPH PATH)` | Counts hops |

### SHORTEST_PATH with specific destination

```sql
-- Shortest path from Alice to Dave specifically
SELECT src.Name                              AS Source,
       STRING_AGG(via.Name, ' -> ')
           WITHIN GROUP (GRAPH PATH)        AS Path,
       COUNT(via.PersonId)
           WITHIN GROUP (GRAPH PATH)        AS HopsCount
FROM   dbo.Person src,
       dbo.Knows  FOR PATH k,
       dbo.Person FOR PATH via
WHERE  MATCH(SHORTEST_PATH(src-(k->via)+))
  AND  src.Name  = 'Alice'
  AND  LAST_VALUE(via.Name) WITHIN GROUP (GRAPH PATH) = 'Dave';
```

### All paths up to N hops (bounded traversal)

```sql
-- Reach up to 3 hops from Alice
SELECT src.Name                              AS Source,
       STRING_AGG(via.Name, ' -> ')
           WITHIN GROUP (GRAPH PATH)        AS Path,
       COUNT(via.PersonId)
           WITHIN GROUP (GRAPH PATH)        AS Hops
FROM   dbo.Person src,
       dbo.Knows  FOR PATH k,
       dbo.Person FOR PATH via
WHERE  MATCH(SHORTEST_PATH(src-(k->via){1,3}))  -- between 1 and 3 hops
  AND  src.Name = 'Alice';
```

Quantifier syntax: `+` (1 or more), `{n}` (exactly n), `{m,n}` (m to n inclusive).

### SHORTEST_PATH limitations

- Returns **one shortest path per source/destination pair** (BFS stops at first). If there are multiple equal-length paths, only one is returned (non-deterministic which one).
- Cannot filter intermediate nodes within SHORTEST_PATH itself; do so in the outer WHERE or a CTE wrapping the result.
- Does not support weighted shortest path — all edges are treated as equal weight. For weighted shortest path (Dijkstra), use a recursive CTE or application-side logic.
- The `FOR PATH` modifier is required on every edge and intermediate node alias used inside SHORTEST_PATH.

---

## 9. LAST_NODE and LAST_EDGE

> [!NOTE] SQL Server 2019
> LAST_NODE and LAST_EDGE were introduced in SQL Server 2019.

In multi-hop queries, LAST_NODE and LAST_EDGE return the final node or edge in a path, which is useful for connecting a SHORTEST_PATH result to a second join.

```sql
-- Find the destination of each shortest path, then join to get its city
SELECT src.Name      AS Source,
       dest.Name     AS Destination,
       dest.City     AS DestCity,
       COUNT(via.PersonId) WITHIN GROUP (GRAPH PATH) AS Hops
FROM   dbo.Person src,
       dbo.Knows  FOR PATH k,
       dbo.Person FOR PATH via,
       dbo.Person dest             -- final destination node
WHERE  MATCH(SHORTEST_PATH(src-(k->via)+)
             AND LAST_NODE(via) = dest)
  AND  src.Name = 'Alice';
```

`LAST_NODE(alias)` in MATCH connects the last node of a SHORTEST_PATH pattern to another table alias in the same FROM clause.

Similarly, `LAST_EDGE(edge_alias)` gives you access to the last edge's columns:

```sql
-- Get the edge weight (if any) at the last hop
SELECT src.Name,
       dest.Name,
       LAST_VALUE(k.SomeWeight) WITHIN GROUP (GRAPH PATH) AS LastHopWeight
FROM   dbo.Person     src,
       dbo.Knows      FOR PATH k,
       dbo.Person     FOR PATH via,
       dbo.Person     dest
WHERE  MATCH(SHORTEST_PATH(src-(k->via)+)
             AND LAST_NODE(via) = dest)
  AND  src.Name = 'Alice';
```

---

## 10. Edge Constraints (2019+)

> [!NOTE] SQL Server 2019
> Edge constraints (CONNECTION constraints) were introduced in SQL Server 2019.

Edge constraints enforce which node types an edge can connect, similar to FK constraints.

```sql
-- Allow edges only from Person to Company
ALTER TABLE dbo.WorksAt
    ADD CONSTRAINT EC_WorksAt_PersonToCompany
        CONNECTION (dbo.Person TO dbo.Company);

-- Allow multiple valid node type combinations on one edge
ALTER TABLE dbo.Rated
    ADD CONSTRAINT EC_Rated_PersonProduct
        CONNECTION (dbo.Person TO dbo.Product),
    ADD CONSTRAINT EC_Rated_PersonService
        CONNECTION (dbo.Person TO dbo.Service);
```

Edge constraints:

- Are enforced on INSERT and UPDATE of the edge's `$from_id`/`$to_id`
- Do NOT prevent deletion of a node (no ON DELETE CASCADE for graph edges)
- Are visible in `sys.edge_constraints` and `sys.edge_constraint_clauses`

```sql
-- View edge constraints
SELECT ec.name                AS ConstraintName,
       OBJECT_NAME(ec.parent_object_id) AS EdgeTable,
       fn.name               AS FromNodeTable,
       tn.name               AS ToNodeTable
FROM   sys.edge_constraints ec
JOIN   sys.edge_constraint_clauses ecc
    ON ecc.object_id = ec.object_id
JOIN   sys.tables fn ON fn.object_id = ecc.from_object_id
JOIN   sys.tables tn ON tn.object_id = ecc.to_object_id;
```

---

## 11. Graph vs Recursive CTE Trade-offs

| Dimension | Graph Tables (MATCH/SHORTEST_PATH) | Recursive CTE |
|---|---|---|
| **Arbitrary depth** | Yes (with SHORTEST_PATH) | Yes (with MAXRECURSION) |
| **Shortest path** | Built-in BFS | Must implement manually (complex) |
| **Weighted shortest path** | Not supported | Implementable (slow) |
| **Multiple edge types** | Yes (multiple edge tables) | Requires JOIN to each relationship type |
| **Edge attributes** | First-class (edge table columns) | Workaround: JOIN to join table |
| **Cycle detection** | Implicit in SHORTEST_PATH (BFS) | Must detect manually |
| **Schema changes** | Add node/edge tables independently | Modify adjacency table structure |
| **Performance (deep graphs)** | Better (BFS engine integration) | Degrades rapidly past ~10 levels |
| **Tooling/compat** | 2017+ only; some BI tools unfamiliar | Works everywhere T-SQL runs |
| **Readability** | MATCH patterns are concise | Multi-level CTE can be hard to follow |
| **Ordering along path** | STRING_AGG WITHIN GROUP (GRAPH PATH) | Row-by-row via anchor/recursive accumulation |
| **Aggregation during traversal** | Limited (WITHIN GROUP only) | Full T-SQL available at each level |

**Decision rule:**

- Simple parent-child hierarchy (org chart, BOM), bounded depth → **recursive CTE**
- Social graph, recommendation network, shortest route, cycle detection → **graph tables**
- Weighted shortest path (Dijkstra, A*) → **application-layer algorithm** feeding SQL for data retrieval

---

## 12. Querying Graph Metadata

```sql
-- List all node tables in the current database
SELECT SCHEMA_NAME(t.schema_id) AS SchemaName,
       t.name                   AS TableName
FROM   sys.tables t
WHERE  t.is_node = 1;

-- List all edge tables
SELECT SCHEMA_NAME(t.schema_id) AS SchemaName,
       t.name                   AS TableName
FROM   sys.tables t
WHERE  t.is_edge = 1;

-- Show hidden graph columns for a table
SELECT c.name,
       c.is_hidden,
       c.graph_type_desc,
       tp.name AS DataType
FROM   sys.columns c
JOIN   sys.types   tp ON tp.user_type_id = c.user_type_id
WHERE  c.object_id = OBJECT_ID('dbo.Knows')
ORDER  BY c.column_id;

-- Count nodes in each node table
SELECT 'Person'  AS NodeType, COUNT(*) AS Cnt FROM dbo.Person UNION ALL
SELECT 'Company' AS NodeType, COUNT(*) AS Cnt FROM dbo.Company;

-- Count edges by edge table
SELECT 'Knows'    AS EdgeType, COUNT(*) AS Cnt FROM dbo.Knows    UNION ALL
SELECT 'WorksAt'  AS EdgeType, COUNT(*) AS Cnt FROM dbo.WorksAt  UNION ALL
SELECT 'Purchased' AS EdgeType, COUNT(*) AS Cnt FROM dbo.Purchased;
```

---

## 13. Indexes on Graph Tables

Graph tables are ordinary tables — all standard index types apply. Effective index patterns:

### Index on user-defined columns (standard)

```sql
CREATE INDEX IX_Person_Name ON dbo.Person (Name);
CREATE INDEX IX_Person_City ON dbo.Person (City);
```

### Index on $from_id / $to_id (for edge traversal)

The engine automatically creates an index on `$edge_id`. But for large graphs, explicit indexes on `$from_id` and `$to_id` dramatically improve MATCH performance:

```sql
-- Speed up outbound traversal: "who does X know?"
CREATE INDEX IX_Knows_From ON dbo.Knows ($from_id);

-- Speed up inbound traversal: "who knows X?"
CREATE INDEX IX_Knows_To   ON dbo.Knows ($to_id);

-- Covering index for edge with attributes
CREATE INDEX IX_Purchased_From_Date
    ON dbo.Purchased ($from_id)
    INCLUDE (PurchaseDate, Amount);
```

> **Note:** `$from_id` and `$to_id` store JSON strings. The internal representation is a bigint pseudo-column. The engine maps the index predicate correctly — you do not need to wrap these in computed columns.

### Check if indexes are helping MATCH

Look for "Index Seek" on the edge table in the actual execution plan. "Index Scan" on a large edge table signals a missing `$from_id` or `$to_id` index.

---

## 14. Gotchas and Anti-patterns

1. **MATCH requires all aliases in FROM.** Every node and edge alias in MATCH must appear in the FROM clause. Omitting one causes a parse error, not a runtime error.

2. **Edges are directed.** `p1-(k)->p2` and `p2-(k)->p1` are different queries. If your relationship is bidirectional, insert two rows (one each direction) or always traverse in both directions with a UNION ALL.

3. **$node_id is a JSON string, not an integer.** You cannot use the integer PK as `$from_id`/`$to_id` directly. Always join through the node table to resolve `$node_id` at insert time. Storing your own integer foreign keys as edge attributes is a common workaround for readability.

4. **No ON DELETE CASCADE for graph.** Deleting a node does not automatically delete its edges. Orphaned edges with invalid `$from_id`/`$to_id` won't error at query time but produce no results. You must clean up edges before deleting nodes (or use edge constraints + manual cleanup).

5. **SHORTEST_PATH returns one path per source/destination pair.** If multiple equal-length paths exist, exactly one is returned — which one is non-deterministic. Do not rely on SHORTEST_PATH to enumerate all paths of minimum length.

6. **SHORTEST_PATH is unweighted.** Each hop costs 1. There is no built-in weighted shortest path. For Dijkstra, use a recursive CTE with a priority accumulator, or handle it in application code.

7. **FOR PATH is mandatory in SHORTEST_PATH.** Edge and intermediate node aliases inside SHORTEST_PATH must have the `FOR PATH` modifier. Forgetting it causes a parse error.

8. **Graph tables are not supported in memory-optimized tables.** You cannot create `AS NODE` or `AS EDGE` on an in-memory table.

9. **MATCH is not supported in all query contexts.** MATCH cannot appear in subqueries, derived tables, or CTEs as the outer reference — it must be in the top-level WHERE clause of its query block. Wrap graph results in a CTE and then filter/join outside.

    ```sql
    -- WRONG: MATCH inside a subquery used in EXISTS
    -- RIGHT: materialize graph results in a CTE first
    WITH GraphResults AS (
        SELECT p1.PersonId AS SourceId, p2.PersonId AS DestId
        FROM   dbo.Person p1, dbo.Knows k, dbo.Person p2
        WHERE  MATCH(p1-(k)->p2)
    )
    SELECT p.Name
    FROM   dbo.Person p
    WHERE  EXISTS (SELECT 1 FROM GraphResults gr WHERE gr.DestId = p.PersonId);
    ```

10. **Compatibility level must be 130+ (SQL Server 2016+) for graph syntax.** The database compatibility level must be at least 130 even though graph tables require SQL Server 2017+. SHORTEST_PATH additionally requires compat level 150 (SQL Server 2019).

11. **No partial-match (fuzzy) on $node_id.** You can't do range scans or LIKE on `$node_id`. Always join node aliases through MATCH or use the user-defined PK columns for filtering.

12. **Graph queries can be hard to optimize.** Complex multi-hop patterns may produce large intermediate result sets. Use `TOP` in the outer query, filter source nodes as early as possible in WHERE, and verify execution plans show seeks not scans on large edge tables.

---

## 15. See Also

- [`04-ctes.md`](04-ctes.md) — recursive CTEs for tree/hierarchy traversal
- [`08-indexes.md`](08-indexes.md) — index design for performance
- [`13-transactions-locking.md`](13-transactions-locking.md) — locking behavior during graph DML
- [`02-syntax-dql.md`](02-syntax-dql.md) — APPLY and set operators useful with graph results

---

## Sources

[^1]: [Graph Processing - SQL Server and Azure SQL Database](https://learn.microsoft.com/en-us/sql/relational-databases/graphs/sql-graph-overview?view=sql-server-ver17) — overview of SQL Server graph database capabilities, node/edge tables, and graph features
[^2]: [MATCH (SQL Graph) - SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/queries/match-sql-graph?view=sql-server-ver17) — MATCH clause syntax for pattern matching and graph traversal
[^3]: [SHORTEST PATH (SQL Graph) - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/graphs/sql-graph-shortest-path?view=sql-server-ver17) — SHORTEST_PATH function for finding minimum-hop paths between nodes
[^4]: [Graph edge constraints - SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/tables/graph-edge-constraints?view=sql-server-ver16) — edge constraints (CONNECTION) for enforcing node type relationships
[^5]: [Graph Processing - SQL Server and Azure SQL Database](https://learn.microsoft.com/en-us/sql/relational-databases/graphs/sql-graph-overview?view=sql-server-ver17) — graph processing with SQL Server and Azure SQL Database

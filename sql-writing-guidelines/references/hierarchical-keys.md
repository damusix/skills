# Hierarchical Composite Keys


Tables in a parent-child hierarchy use composite primary keys that grow wider as the hierarchy deepens. Each child table inherits the full primary key of its parent and adds its own discriminator. This makes the key itself a path — it encodes the full lineage from root to leaf without requiring joins.

## Table of Contents

- [The Pattern](#the-pattern)
- [Max-Plus-One Functions](#max-plus-one-functions)
- [Why Not IDENTITY Columns](#why-not-identity-columns)
- [Temporal Child Records](#temporal-child-records)
- [Sibling Children](#sibling-children)
- [Procedures for Hierarchical Inserts](#procedures-for-hierarchical-inserts)
- [Physical Disk Locality](#physical-disk-locality)

---

## The Pattern

Consider an order management system. Each customer has orders, each order has lines, each line has shipments:

    CREATE TABLE Customer (
        CustomerNo CustomerNo,

        [Name] [Name],
        Email Email,

        CONSTRAINT PK_Customer PRIMARY KEY (CustomerNo)
    );

    CREATE TABLE [Order] (
        CustomerNo CustomerNo,
        OrderNo OrderNo,

        OrderDate _Timestamp,
        [Status] _Type,

        CONSTRAINT PK_Order PRIMARY KEY (CustomerNo, OrderNo),

        CONSTRAINT Order_IsPlacedBy_Customer
            FOREIGN KEY (CustomerNo)
            REFERENCES Customer(CustomerNo),

        CONSTRAINT Order_IsStatedBy_OrderStatus
            FOREIGN KEY ([Status])
            REFERENCES OrderStatus([Status])
    );

    CREATE TABLE OrderLine (
        CustomerNo CustomerNo,
        OrderNo OrderNo,
        LineNo LineNo,

        ProductName [Name],
        Quantity _Int,
        UnitPrice _Money,

        CONSTRAINT PK_OrderLine PRIMARY KEY (CustomerNo, OrderNo, LineNo),

        CONSTRAINT OrderLine_IsContainedIn_Order
            FOREIGN KEY (CustomerNo, OrderNo)
            REFERENCES [Order](CustomerNo, OrderNo)
    );

    CREATE TABLE OrderLine_Shipment (
        CustomerNo CustomerNo,
        OrderNo OrderNo,
        LineNo LineNo,
        ShipmentNo ShipmentNo,

        ShippedDate _Timestamp,
        Carrier [Name],
        TrackingNumber TrackingNo,

        CONSTRAINT PK_OrderLine_Shipment PRIMARY KEY (CustomerNo, OrderNo, LineNo, ShipmentNo),

        CONSTRAINT OrderLine_Shipment_IsFulfilledBy_OrderLine
            FOREIGN KEY (CustomerNo, OrderNo, LineNo)
            REFERENCES OrderLine(CustomerNo, OrderNo, LineNo)
    );

The primary key grows wider at each level:

| Level | Table | Primary Key |
|-------|-------|-------------|
| 1 | `Customer` | `(CustomerNo)` |
| 2 | `Order` | `(CustomerNo, OrderNo)` |
| 3 | `OrderLine` | `(CustomerNo, OrderNo, LineNo)` |
| 4 | `OrderLine_Shipment` | `(CustomerNo, OrderNo, LineNo, ShipmentNo)` |

Each child's PK is its parent's PK plus one new column. The FK to the parent references the parent's full PK. This means every child row carries its full ancestry — you can read the key `(CustomerNo=42, OrderNo=3, LineNo=1, ShipmentNo=2)` and know exactly which customer, order, and line item this shipment belongs to without joining anything.

---

## Max-Plus-One Functions

Instead of auto-incrementing IDENTITY columns, each table gets a dedicated scalar function that computes the next key value: take the current maximum within the parent's scope and add one.

    -- Root entity: next key across the entire table
    CREATE OR ALTER FUNCTION dbo.NextCustomerNo_fn()
    RETURNS CustomerNo AS BEGIN
        RETURN ISNULL((SELECT MAX(CustomerNo) FROM Customer), 0) + 1;
    END;

    -- Scoped to parent: next key within a specific customer's orders
    CREATE OR ALTER FUNCTION dbo.NextOrderNo_fn(@CustomerNo CustomerNo)
    RETURNS OrderNo AS BEGIN
        RETURN ISNULL((SELECT MAX(OrderNo) FROM [Order]
            WHERE CustomerNo = @CustomerNo), 0) + 1;
    END;

    -- Deeper scope: next key within a specific order's lines
    CREATE OR ALTER FUNCTION dbo.NextLineNo_fn(
        @CustomerNo CustomerNo,
        @OrderNo OrderNo
    )
    RETURNS LineNo AS BEGIN
        RETURN ISNULL((SELECT MAX(LineNo) FROM OrderLine
            WHERE CustomerNo = @CustomerNo
                AND OrderNo = @OrderNo), 0) + 1;
    END;

The key generation is always scoped to the parent. `OrderNo` 1 exists for every customer. `LineNo` 1 exists for every order. The numbers are local to their parent, not global.

Each function accepts the full parent key as parameters and returns the next discriminator for that parent. The function name follows the `Next<Column>_fn` convention so its purpose is self-documenting.

---

## Why Not IDENTITY Columns

IDENTITY columns are global auto-incrementers managed by SQL Server. They produce monotonically increasing integers across all rows in a table regardless of parent scope. Hierarchical composite keys with max-plus-one offer several advantages:

**Scoped sequences.** OrderNo resets to 1 for each customer. If Customer 42 has OrderNo 7, you know they've placed at least 7 orders — ever. You can infer approximate counts by reading a key. With IDENTITY, OrderNo 95847 tells you nothing about this customer; it's a global counter shared across all customers.

**Human-readable paths.** A key like `(CustomerNo=42, OrderNo=3, LineNo=1)` reads naturally — it's customer 42's third order, first line item. Support staff, database administrators, and developers can reason about the data by reading keys alone. `(OrderID=95847, LineID=284511)` is opaque — you need joins to understand what you're looking at.

**Physical locality.** With a clustered composite key, all of Customer 42's orders are physically adjacent on disk. All of Order 3's line items are adjacent within that. SQL Server stores clustered index rows in key order — hierarchical keys naturally group parent-child data together, making range scans and parent-scoped queries fast. IDENTITY keys scatter children across the table in insertion order, intermixed with children of other parents.

**Deterministic key values.** Max-plus-one produces the same key given the same state — it's a function of the data. IDENTITY values depend on insertion order and can have gaps (from rollbacks, cache loss on server restart, or reseeding). Deterministic keys are easier to reason about in testing, migrations, and debugging.

**Historical inference.** If the latest StipulationNo for a case is 3, you know the case has had at least 3 stipulations. If the latest PaymentNo for that stipulation is 5, you know at least 5 payments were recorded. These aren't exact current counts (deletions can create gaps), but they're useful context clues — a high number signals an active, complex record.

---

## Temporal Child Records

When child records represent snapshots over time — prices, rates, statuses — use a timestamp as the final key component instead of a sequential number:

    CREATE TABLE OrderLine_PriceHistory (
        CustomerNo CustomerNo,
        OrderNo OrderNo,
        LineNo LineNo,
        EffectiveDate _Timestamp,

        UnitPrice _Money,
        Reason Description,

        CONSTRAINT PK_OrderLine_PriceHistory
            PRIMARY KEY (CustomerNo, OrderNo, LineNo, EffectiveDate),

        CONSTRAINT OrderLine_PriceHistory_IsPricedBy_OrderLine
            FOREIGN KEY (CustomerNo, OrderNo, LineNo)
            REFERENCES OrderLine(CustomerNo, OrderNo, LineNo)
    );

The timestamp is a natural key — it inherently orders the records chronologically. To get the latest price, query with `ORDER BY EffectiveDate DESC` or use `OUTER APPLY` with `TOP 1`. No max-plus-one needed; the datetime itself is the discriminator.

---

## Sibling Children

A parent can have multiple child tables at the same level. Each inherits the parent's full key and adds its own discriminator:

    -- Sibling 1: payments on an order
    CREATE TABLE Order_Payment (
        CustomerNo CustomerNo,
        OrderNo OrderNo,
        PaymentNo PaymentNo,

        Amount _Money,
        PaidDate _Timestamp,
        Method _Type,

        CONSTRAINT PK_Order_Payment PRIMARY KEY (CustomerNo, OrderNo, PaymentNo),

        CONSTRAINT Order_Payment_IsSettledBy_Order
            FOREIGN KEY (CustomerNo, OrderNo)
            REFERENCES [Order](CustomerNo, OrderNo)
    );

    -- Sibling 2: notes on an order
    CREATE TABLE Order_Note (
        CustomerNo CustomerNo,
        OrderNo OrderNo,
        NoteNo NoteNo,

        [Text] Comment,
        CreatedAt _Timestamp,

        CONSTRAINT PK_Order_Note PRIMARY KEY (CustomerNo, OrderNo, NoteNo),

        CONSTRAINT Order_Note_IsAnnotatedBy_Order
            FOREIGN KEY (CustomerNo, OrderNo)
            REFERENCES [Order](CustomerNo, OrderNo)
    );

Both `Order_Payment` and `Order_Note` share the `(CustomerNo, OrderNo)` prefix. Their discriminators (`PaymentNo`, `NoteNo`) are independently scoped — PaymentNo 1 and NoteNo 1 coexist for the same order.

---

## Procedures for Hierarchical Inserts

When inserting into a child table, the procedure calls the max-plus-one function to generate the new discriminator, then inserts with the full composite key:

    SET @ShipmentNo = dbo.NextShipmentNo_fn(@CustomerNo, @OrderNo, @LineNo);

    INSERT INTO OrderLine_Shipment (
        CustomerNo, OrderNo, LineNo, ShipmentNo,
        ShippedDate, Carrier, TrackingNumber
    )
    VALUES (
        @CustomerNo, @OrderNo, @LineNo, @ShipmentNo,
        SYSDATETIME(), @Carrier, @TrackingNumber
    );

The function call and INSERT happen inside a transaction. Concurrency protection (preventing two concurrent inserts from computing the same next value) is managed by the procedure's transaction and locking strategy — see [Procedure Structure](procedure-structure.md) for the full `_trx` / `_utx` templates.

---

## Physical Disk Locality

Each table has its own clustered index, and the clustered index IS the table — leaf pages store data rows in key order. With hierarchical composite keys as the clustered PK, all children of the same parent are physically adjacent within that table:

    -- Within the OrderLine table, rows are stored in composite key order:
    (42, 1, 1)  -- Customer 42, Order 1, Line 1
    (42, 1, 2)  -- Customer 42, Order 1, Line 2
    (42, 1, 3)  -- Customer 42, Order 1, Line 3
    (42, 2, 1)  -- Customer 42, Order 2, Line 1
    (42, 2, 2)  -- Customer 42, Order 2, Line 2
    -- Customer 43's line items follow:
    (43, 1, 1)  -- Customer 43, Order 1, Line 1

A query like `SELECT * FROM OrderLine WHERE CustomerNo = 42 AND OrderNo = 1` is a contiguous range scan — the rows are next to each other on disk. With an IDENTITY column as the clustered PK, lines for different orders would be intermixed in insertion order, scattering Customer 42's data across the table.

This locality benefit applies independently within each table in the hierarchy. Within the Order table, all of Customer 42's orders are adjacent. Within OrderLine, all lines for Order 1 are adjacent. Within Shipment, all shipments for a given line item are adjacent. The deeper the hierarchy, the more each table benefits from parent-scoped range scans.

# Migration Patterns


Migrations must be **idempotent** — safe to run multiple times without error. Every DDL operation is wrapped in a meta-function existence check.

## Table of Contents

- [Meta Functions](#meta-functions)
- [Building Meta Functions](#building-meta-functions)
- [Adding a Column](#adding-a-column)
- [Adding a Table](#adding-a-table)
- [Adding a Constraint](#adding-a-constraint)
- [Adding an Index](#adding-an-index)
- [Changing a Column Type](#changing-a-column-type)
- [Dropping a Constraint](#dropping-a-constraint)
- [Creating a Custom Type](#creating-a-custom-type)

---

## Meta Functions

A library of scalar functions that query `sys.*` catalog views to check whether objects exist. Every project using this methodology should build and maintain these.

### Object Existence

| Function | Returns 1 if... |
|----------|-----------------|
| `TableExists_fn('Name')` | Table exists |
| `ViewExists_fn('Name')` | View exists |
| `ProcedureExists_fn('Name')` | Procedure exists |
| `ScalarFunctionExists_fn('Name')` | Scalar function exists |
| `TableFunctionExists_fn('Name')` | Table-valued function exists (multi-statement or inline) |
| `TypeExists_fn('Name')` | User-defined type exists |
| `SchemaExists_fn('Name')` | Schema exists |

### Column Inspection

| Function | Returns |
|----------|---------|
| `ColumnExists_fn('Table', 'Column')` | 1 if column exists |
| `ColumnIsNullable_fn('Table', 'Column')` | 1 if column allows NULL |
| `ColumnIsIdentity_fn('Table', 'Column')` | 1 if column is an identity column |
| `ColumnIsComputed_fn('Table', 'Column')` | 1 if column is computed |
| `ColumnDataType_fn('Table', 'Column')` | Type name as string (e.g., `Name`) |
| `ColumnFullType_fn('Table', 'Column')` | Full type with size (e.g., `varchar(255)`, `decimal(10,2)`) |

### Constraint Existence

| Function | Returns 1 if... |
|----------|-----------------|
| `ForeignKeyExists_fn('Name')` | Foreign key constraint exists |
| `CheckConstraintExists_fn('Name')` | Check constraint exists |
| `DefaultConstraintExists_fn('Table', 'Column')` | Default constraint exists on column |
| `DefaultConstraintExistsByName_fn('Name')` | Default constraint exists by name |
| `UniqueConstraintExists_fn('Name')` | Unique constraint exists |
| `PrimaryKeyExists_fn('Table')` | Primary key exists on table |
| `PrimaryKeyExistsByName_fn('Name')` | Primary key exists by constraint name |

### Index Inspection

| Function | Returns |
|----------|---------|
| `IndexExists_fn('Table', 'IndexName')` | 1 if index exists |
| `IndexIsUnique_fn('Table', 'IndexName')` | 1 if index is unique |
| `IndexIsClustered_fn('Table', 'IndexName')` | 1 if index is clustered |
| `IndexIncludesColumn_fn('Table', 'IndexName', 'Column')` | 1 if index includes column |
| `GetIndexType_fn('Table', 'IndexName')` | Type description (e.g., `CLUSTERED`, `NONCLUSTERED`) |

### Utilities

| Function | Returns |
|----------|---------|
| `GetDefaultConstraintName_fn('Table', 'Column')` | Auto-generated constraint name (for dropping) |

---

## Building Meta Functions

These functions are straightforward wrappers around `sys.*` views. Here are two examples:

    CREATE OR ALTER FUNCTION dbo.TableExists_fn(@TableName NVARCHAR(128))
    RETURNS BIT AS BEGIN
        RETURN CASE
            WHEN EXISTS (
                SELECT 1 FROM sys.tables WHERE name = @TableName
            ) THEN 1 ELSE 0
        END;
    END;

    CREATE OR ALTER FUNCTION dbo.ColumnExists_fn(
        @TableName NVARCHAR(128),
        @ColumnName NVARCHAR(128)
    )
    RETURNS BIT AS BEGIN
        RETURN CASE
            WHEN EXISTS (
                SELECT 1 FROM sys.columns
                WHERE object_id = OBJECT_ID(@TableName)
                  AND name = @ColumnName
            ) THEN 1 ELSE 0
        END;
    END;

    CREATE OR ALTER FUNCTION dbo.GetDefaultConstraintName_fn(
        @TableName NVARCHAR(128),
        @ColumnName NVARCHAR(128)
    )
    RETURNS NVARCHAR(128) AS BEGIN
        RETURN (
            SELECT dc.name
            FROM sys.default_constraints dc
            INNER JOIN sys.columns c
                ON dc.parent_object_id = c.object_id
                AND dc.parent_column_id = c.column_id
            WHERE dc.parent_object_id = OBJECT_ID(@TableName)
              AND c.name = @ColumnName
        );
    END;

Build the full set once for your project; they pay for themselves in every migration.

---

## Adding a Column

    IF dbo.ColumnExists_fn('Customer', 'IsVerified') = 0
        ALTER TABLE Customer ADD IsVerified _Bool NOT NULL DEFAULT 0;

If the column has a custom type with a standard default binding, use that default value.

---

## Adding a Table

    IF dbo.TableExists_fn('Subscription') = 0 BEGIN
        CREATE TABLE Subscription (
            SubscriptionNo _Int PRIMARY KEY,
            CustomerNo _Int NOT NULL,
            PlanName Name NOT NULL,
            StartDate _Date NOT NULL,
            CreatedAt _Timestamp NOT NULL DEFAULT SYSDATETIME(),

            CONSTRAINT Subscription_BelongsTo_Customer
                FOREIGN KEY(CustomerNo) REFERENCES Customer(CustomerNo)
        );
    END

---

## Adding a Constraint

### Foreign Key

    IF dbo.ForeignKeyExists_fn('Order_BelongsTo_Customer') = 0 BEGIN
        ALTER TABLE [Order]
        ADD CONSTRAINT Order_BelongsTo_Customer
        FOREIGN KEY (CustomerNo) REFERENCES Customer(CustomerNo);
    END

### Check Constraint

    IF dbo.CheckConstraintExists_fn('Discount_MustBePositive') = 0 BEGIN
        ALTER TABLE Discount
        ADD CONSTRAINT Discount_MustBePositive
        CHECK (Amount > 0);
    END

### Unique Constraint

    IF dbo.UniqueConstraintExists_fn('Customer_Email_IsUnique') = 0 BEGIN
        ALTER TABLE Customer
        ADD CONSTRAINT Customer_Email_IsUnique UNIQUE (Email);
    END

---

## Adding an Index

    IF dbo.IndexExists_fn('Customer', 'IX_Customer_Email') = 0
        CREATE UNIQUE INDEX IX_Customer_Email ON Customer(Email);

---

## Changing a Column Type

The most involved pattern. Default constraints must be dropped before altering a column, and auto-generated constraint names must be looked up dynamically:

    -- 1. Verify the new custom type exists
    IF dbo.TypeExists_fn('Email') = 0 BEGIN
        RAISERROR('Email type must exist before this migration.', 16, 1);
        RETURN;
    END

    -- 2. Check if the column actually needs migration
    IF dbo.ColumnDataType_fn('Customer', 'ContactEmail') <> 'Email' BEGIN

        -- 3. Drop the auto-generated default constraint if one exists
        DECLARE @DefConstraint NVARCHAR(128);
        SET @DefConstraint = dbo.GetDefaultConstraintName_fn('Customer', 'ContactEmail');

        IF @DefConstraint IS NOT NULL
            EXEC('ALTER TABLE Customer DROP CONSTRAINT ' + @DefConstraint);

        -- 4. Alter the column to use the custom type
        ALTER TABLE Customer ALTER COLUMN ContactEmail Email NOT NULL;
    END

---

## Dropping a Constraint

### Named constraint

    IF dbo.ForeignKeyExists_fn('OldConstraintName') = 1
        ALTER TABLE SomeTable DROP CONSTRAINT OldConstraintName;

### Auto-generated default constraint (name unknown)

    DECLARE @ConstraintName NVARCHAR(128);
    SET @ConstraintName = dbo.GetDefaultConstraintName_fn('SomeTable', 'SomeColumn');

    IF @ConstraintName IS NOT NULL
        EXEC('ALTER TABLE SomeTable DROP CONSTRAINT ' + @ConstraintName);

---

## Creating a Custom Type

    IF dbo.TypeExists_fn('PhoneNumber') = 0
        CREATE TYPE PhoneNumber FROM VARCHAR(31) NOT NULL;

After creating a new type, add it to your project's type manifest so the type system stays centralized.

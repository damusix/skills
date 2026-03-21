# Normal Form Violations

Practical reference mapping each Normal Form violation to its SQL Server symptom and fix. For formal definitions of all 16 NFs, see `relational-db-design`.

---

## ADNF — Atomic Domain NF (Codd 1NF)

**Violation:** Using the wrong SQL type for the logical domain. Splitting an atomic value into parts.

| Symptom | Fix |
|---------|-----|
| Storing dates as `VARCHAR` or `INT` year/month/day columns | Use `DATE` or `DATETIME2`; define `_Date`, `_Timestamp` types |
| Storing a boolean flag as `CHAR(1)` (`'Y'`/`'N'`) | Use `BIT`; define `_Bool` type |
| Storing a money value as `VARCHAR` | Use `DECIMAL`/`NUMERIC`; define `_Money` type |
| Storing a CSV list in a single column | Move each element to a child row |

**Principle:** If the DBMS has a type for the domain, use it. If you're storing a set inside a column, you're violating atomicity.

---

## FDNF — Formal Domain NF

**Violation:** Inconsistent type definitions for the same logical concept across tables.

| Symptom | Fix |
|---------|-----|
| `VARCHAR(100)` in one table, `VARCHAR(256)` in another for the same thing | Define a named type (`Email`, `Name`) and use it everywhere |
| `INT` for one customer key, `BIGINT` for another | One named type (`CustomerNo`) applied consistently |
| Different NULL/NOT NULL for the same domain in different tables | NOT NULL in the type definition; nullable only by explicit business choice |

**Fix pattern:**

    -- Define once
    CREATE TYPE Email FROM VARCHAR(254) NOT NULL;
    CREATE TYPE CustomerNo FROM INT NOT NULL;

    -- Use everywhere — consistency is enforced by the type
    CustomerEmail   Email,
    ContactEmail    Email,
    BillingEmail    Email

---

## SNF — Subordinate NF (Codd 2NF)

**Violation:** Repeating attribute groups encoded as numbered columns.

| Symptom | Fix |
|---------|-----|
| `SalesJan`, `SalesFeb`, ..., `SalesDec` in one row | Child table `(SupplierNo, Year, Month)` with one `Sales` column |
| `Phone1`, `Phone2`, `Phone3` | Child table `(PartyNo, PhoneNo)` with one `Phone` column |
| `Tag1`, `Tag2`, `Tag3`, `Tag4` | Child table `(EntityNo, TagNo)` |

**Fix pattern:**

    -- Before (SNF violation):
    CREATE TABLE SupplierSales (
        SupplierNo  SupplierNo  PRIMARY KEY,
        SalesJan    _Money      NOT NULL,
        SalesFeb    _Money      NOT NULL,
        -- ... x12
    );

    -- After (SNF compliant):
    CREATE TABLE SupplierSales (
        SupplierNo  SupplierNo  NOT NULL,
        Year        _Year       NOT NULL,
        Month       _Month      NOT NULL,
        Sales       _Money      NOT NULL,
        CONSTRAINT SupplierSales_PK PRIMARY KEY (SupplierNo, Year, Month),
        CONSTRAINT SupplierSales_Is_Supplier FOREIGN KEY (SupplierNo) REFERENCES Supplier(SupplierNo)
    );

---

## HNF — Hierarchic NF

**Violation:** Tables not arranged into their natural hierarchies. Circular references.

| Symptom | Fix |
|---------|-----|
| Two tables FK each other (circular reference) | Determine the correct parent-child direction; eliminate the backwards FK |
| A table that "could be a child of several things depending on context" | It is a child of all of them via a Binary Fact (BFNF), or it needs redesign |
| A table floating with no identifying parent and no clear reference role | Classify it — is it a Hierarch? A Reference? If it "sort of" belongs to something, that something is its parent |

**Principle:** Every table has exactly one identifying parent, or it is a root (Hierarch/Reference). If it has two identifying parents, use Binary Fact NF.

---

## RKNF — Relational Key NF

**Violation:** The Primary Key does not encode the Fact's position in the hierarchy. Surrogate keys on child tables.

| Symptom | Fix |
|---------|-----|
| `INT IDENTITY` on a table that has a parent | Replace with composite key: parent PK + own discriminator |
| Child PK does not include parent PK | Add parent PK columns to child PK |
| FK to parent exists but is not part of the PK | The child is not identified by its parent — rethink the hierarchy |
| `id` column that is just a row number | Rename and make it meaningful, or replace with composite key |

**Fix pattern:**

    -- Before (RKNF violation — surrogate severs child from parent):
    CREATE TABLE OrderLine (
        Id          INT IDENTITY PRIMARY KEY,
        OrderId     INT NOT NULL FOREIGN KEY REFERENCES [Order](Id),
        Quantity    _Quantity NOT NULL
    );

    -- After (RKNF compliant — child key encodes full lineage):
    CREATE TABLE OrderLine (
        CustomerNo  CustomerNo  NOT NULL,
        OrderNo     OrderNo     NOT NULL,
        LineNo      LineNo      NOT NULL,
        Quantity    _Quantity   NOT NULL,
        CONSTRAINT OrderLine_PK PRIMARY KEY (CustomerNo, OrderNo, LineNo),
        CONSTRAINT OrderLine_Belongs_To_Order
            FOREIGN KEY (CustomerNo, OrderNo) REFERENCES [Order](CustomerNo, OrderNo)
    );

**The consequence of RKNF violation (Relational Breach):** A `JOIN` from `OrderShipment` to `Customer` requires going through `OrderLine` → `Order` → `Customer`. With a surrogate key, each step loses the parent context. With composite keys, `CustomerNo` is already in `OrderShipment` — one direct `JOIN`.

---

## DFNF — Defined Fact NF

**Violation:** Business rules that exist in reality are not declared in the schema. Missing FKs, missing CHECK constraints, undocumented relationships.

| Symptom | Fix |
|---------|-----|
| FK relationship exists logically but no `FOREIGN KEY` constraint | Add the constraint with a predicate name |
| A column should only accept certain values but has no constraint | Add `CHECK` or FK to a reference table |
| A subtype column exists but discriminator is not enforced | Add discriminator function + `CHECK` constraint |
| Application code validates what the schema should enforce | Move validation into a `CHECK` constraint or functional constraint |

**Principle:** Every Predicate that is true about the Fact must be declared in the schema. If a business rule lives only in application code, it is absent from the Fact Definition and will be violated the moment someone touches the table directly.

---

## KDNF — Key Dependency NF (Codd 3NF)

**Violation:** A column does not depend on the full Primary Key, or depends on something that is not the key.

| Symptom | Fix |
|---------|-----|
| A column describes the parent, not the child | Move it to the parent table |
| A column depends on a non-key attribute | Extract to a separate table keyed by the determinant |
| Denormalized column that duplicates data from a parent | Remove it; use a `VIEW` or `JOIN` to read it |
| `CustomerName` stored in `Order` alongside `CustomerNo` | Remove `CustomerName` from `Order`; `JOIN` to `Customer` |

**Fix pattern:**

    -- Before (KDNF violation — CustomerCity depends on CustomerNo, not OrderNo):
    CREATE TABLE [Order] (
        CustomerNo      CustomerNo  NOT NULL,
        OrderNo         OrderNo     NOT NULL,
        CustomerCity    _City       NOT NULL,  -- belongs in Customer
        OrderDate       _Date       NOT NULL,
        ...
    );

    -- After:
    -- CustomerCity lives in Customer where it belongs.
    -- Order gets it via JOIN when needed.

---

## IDNF — Isolated Descriptor NF

**Violation:** Optional attributes left as nullable columns on the main table.

| Symptom | Fix |
|---------|-----|
| Column that is `NULL` for most rows | Move to a separate 1::1 child table where it is `NOT NULL` |
| `ProfileBio VARCHAR(MAX) NULL` on a `User` table | Create `UserProfile (UserNo PK+FK, Bio _LongText NOT NULL)` |
| Pivot/reporting columns mixed into the transactional table | Isolate to a separate table or view |

**Fix pattern:**

    -- Before (nullable optional column):
    CREATE TABLE Customer (
        CustomerNo  CustomerNo  PRIMARY KEY,
        Name        _Name       NOT NULL,
        Bio         VARCHAR(MAX) NULL  -- most customers have no bio
    );

    -- After (IDNF — isolated, optional, NOT NULL):
    CREATE TABLE Customer (
        CustomerNo  CustomerNo  PRIMARY KEY,
        Name        _Name       NOT NULL
    );

    CREATE TABLE CustomerBio (
        CustomerNo  CustomerNo   PRIMARY KEY,
        Bio         _LongText    NOT NULL,
        CONSTRAINT CustomerBio_Is_Customer
            FOREIGN KEY (CustomerNo) REFERENCES Customer(CustomerNo)
    );

---

## FCNF — Fully Constrained NF

**Violation:** Columns have no domain constraint beyond their raw datatype. Cross-table business rules not enforced by the schema.

| Symptom | Fix |
|---------|-----|
| `Status VARCHAR(20)` with no constraint on valid values | FK to `StatusType` reference table, or `CHECK` with `IN (...)` |
| Bare `INT`/`VARCHAR` columns with no meaning constraint | Add `CHECK` constraints or use a reference table |
| "Only valid if related record is type X" enforced in app code only | Functional constraint: `CHECK (dbo.Entity_IsType_fn(Key, 'X') = 1)` |

**Fix pattern:**

    -- Functional constraint enforcing cross-table type rule:
    CREATE FUNCTION dbo.Account_IsType_fn (
        @AccountNo AccountNo,
        @ExpectedType _Type
    )
    RETURNS BIT AS BEGIN
        RETURN (SELECT CASE WHEN EXISTS (
            SELECT 1 FROM Account WHERE AccountNo = @AccountNo AND [Type] = @ExpectedType
        ) THEN 1 ELSE 0 END);
    END;

    CREATE TABLE SavingsAccount (
        AccountNo   AccountNo   PRIMARY KEY,
        -- ...
        CONSTRAINT SavingsAccount_Is_Account
            FOREIGN KEY (AccountNo) REFERENCES Account(AccountNo),
        CONSTRAINT SavingsAccount_IsAccountType
            CHECK (dbo.Account_IsType_fn(AccountNo, 'Savings') = 1)
    );

---

## BFNF — Binary Fact NF

**Violation:** A many-to-many relationship between two entities is not resolved into an associative table with a proper composite key.

| Symptom | Fix |
|---------|-----|
| `IDENTITY` surrogate on an associative table | Remove it; PK = both parent PKs |
| Many-to-many resolved as comma-separated IDs in a column | Create proper associative table |
| Junction table exists but has its own surrogate PK | Replace surrogate with `(ParentAKey, ParentBKey)` composite |

**Fix pattern:**

    -- Before (surrogate on associative table — BFNF violation):
    CREATE TABLE UserRole (
        Id      INT IDENTITY PRIMARY KEY,
        UserId  INT NOT NULL FOREIGN KEY REFERENCES [User](Id),
        RoleId  INT NOT NULL FOREIGN KEY REFERENCES [Role](Id)
    );

    -- After (BFNF compliant — PK is both parents):
    CREATE TABLE UserRole (
        UserNo  UserNo  NOT NULL,
        RoleNo  RoleNo  NOT NULL,
        CONSTRAINT UserRole_PK PRIMARY KEY (UserNo, RoleNo),
        CONSTRAINT UserRole_Has_User FOREIGN KEY (UserNo) REFERENCES [User](UserNo),
        CONSTRAINT UserRole_Has_Role FOREIGN KEY (RoleNo) REFERENCES [Role](RoleNo)
    );

---

## BSNF — Basetype Subtype NF

**Violation:** Subtype-specific attributes stored as nullable columns in the base table.

| Symptom | Fix |
|---------|-----|
| `InterestRate DECIMAL NULL` on an `Account` table where only savings accounts have interest | Extract to `SavingsAccount` subtype table |
| Nullable columns that "only apply when Type = X" | Each type gets its own subtype table; all columns NOT NULL |
| `Type` discriminator column exists but no structural enforcement | Add functional constraint on subtype tables |

See [Base/Subtype Inheritance](basetype-subtype.md) for the complete pattern.

---

## Relational Breach Form

**The worst violation:** A child table's Primary Key does not include the parent's Primary Key. The child is severed from its ancestry.

**Recognition:**

    -- Every IDENTITY FK pattern is a breach:
    OrderLine.Id INT IDENTITY PRIMARY KEY
    OrderLine.OrderId INT NOT NULL FK -> Order.Id

**Consequence:** `JOIN` from `OrderShipment` to `Customer` requires traversing every intermediate table — you cannot `JOIN` directly. As the hierarchy deepens, performance and complexity compound.

**Fix:** Composite keys that carry the full ancestry. See the RKNF section above.

---

## Quick Lookup

| NF | Core violation | SQL Server symptom |
|----|---------------|--------------------|
| ADNF | Wrong type for the domain | `VARCHAR` for dates, `CHAR(1)` for booleans |
| FDNF | Inconsistent type definitions | Same concept, different sizes in different tables |
| SNF | Repeating column groups | `Col1`, `Col2`, `Col3` pattern |
| HNF | Not in a hierarchy / circular refs | Circular FKs, floating tables |
| RKNF | Surrogate PK on child table | `INT IDENTITY` child PK + FK to parent |
| DFNF | Undeclared business rules | Missing FKs, missing CHECKs, rules in app code only |
| KDNF | Column in wrong table | Denormalized data, partial key dependence |
| IDNF | Nullable optional columns | `NULL` columns on most rows |
| FCNF | Missing domain constraints | Bare `VARCHAR`/`INT`, no CHECK, no reference table |
| BFNF | Surrogate on associative table | `IDENTITY` PK on junction table |
| BSNF | Nullable subtype columns in base | `NULL` columns that "only apply when Type = X" |
| RBF | Child severed from ancestry | Any `IDENTITY` child PK with FK-only relation to parent |

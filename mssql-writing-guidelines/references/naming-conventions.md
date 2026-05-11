# Naming Conventions


Every identifier in the schema is **PascalCase** — tables, columns, views, procedures, functions, constraints, types, parameters. No underscores between words, no camelCase, no UPPER_CASE. Underscores appear only in suffixes (`_fn`, `_V`, `_trx`) and structural separators (`Role_Intent_V`, `Subject_Relationship_Object`).

## Table of Contents

- [Quick Reference](#quick-reference)
- [Tables](#tables)
- [Columns](#columns)
- [Views](#views)
- [Procedures](#procedures)
- [Functions](#functions)
- [Constraints](#constraints)
- [Custom Types](#custom-types)
- [Parameters](#parameters)
- [Indexes](#indexes)
- [Abbreviations](#abbreviations)

---

## Quick Reference

| Object | Pattern | Examples |
|--------|---------|----------|
| Tables | `EntityName` | `Account`, `Customer`, `OrderLine` |
| Subtypes | `Base_Subtype` | `Notification_Email`, `Notification_ResetPassword` |
| Join tables | `Entity_Entity` | `Community_User`, `Order_Payment` |
| Columns | `PascalCaseNoun` | `FirstName`, `OrderDate`, `IsActive` |
| Views | `Role_Intent_V` | `Manager_TeamReport_V`, `Admin_AllCustomers_V` |
| Procedures | `Verb_Domain_{trx,utx,ut}` | `Add_OrderLine_trx`, `FindCustomer_ut` |
| Functions | `Descriptive_fn` | `Account_IsType_fn`, `NextOrderNo_fn` |
| Constraints | `Subject_Relationship_Object` | `Customer_Rents_Vehicle`, `SavingsAccount_Is_Account` |
| Custom types | `DomainName` or `_Primitive` | `Email`, `AccountNo`, `_Timestamp`, `_Bool` |
| Parameters | `@PascalCase` | `@CustomerNo`, `@Status`, `@ScheduledFor` |
| Indexes | `IX_Table_Columns` | `IX_Customer_Email`, `IX_Order_CustomerNo` |

---

## Tables

Tables are named as singular nouns describing the entity:

    Account          -- not Accounts (singular, not plural)
    Customer         -- not tbl_Customer (no prefixes)
    OrderLine        -- compound words joined in PascalCase
    UnitType         -- not Unit_Type (no underscores between words)

**Subtype tables** use `Base_Subtype`:

    Notification_Email          -- subtype of Notification
    Notification_ResetPassword  -- subtype of Notification

**Join/bridge tables** use `Entity_Entity`:

    Community_User              -- links Community to User
    Community_CourtHouse        -- links Community to CourtHouse

**Child tables** with hierarchical keys use `Parent_Child`:

    Order_Payment               -- payment belonging to an order
    UnitType_BasePrice          -- base price belonging to a unit type
    OrderLine_Shipment          -- shipment belonging to an order line

**Reference/lookup tables** are named after what they classify:

    AccountType                 -- classifies Account
    QueueStatus                 -- classifies queue states
    IntervalType                -- classifies lease interval types

---

## Columns

Columns are PascalCase nouns or noun phrases. The name describes what the column holds, not how it's stored:

    FirstName        -- not first_name, not fName
    OrderDate        -- not order_date
    IsActive         -- boolean columns prefixed with Is/Has/Can
    CreatedAt        -- timestamps suffixed with At
    ScheduledFor     -- temporal intent suffixed with For

**Primary key columns** are named after the entity they identify:

    CustomerNo       -- not CustomerID, not ID, not customer_id
    AccountNo        -- the No suffix is a convention for sequential identifiers
    EntrataID        -- when the ID comes from an external system, name it after the source

**Foreign key columns** use the parent entity's PK name or a role-descriptive name:

    CustomerNo       -- matches Customer.CustomerNo exactly
    Community        -- when the relationship is contextual, the column name describes the role
    AppUser          -- describes which user (not just UserID)

The column name should match the parent PK column name when the relationship is direct and unambiguous. When a table has multiple FKs to the same parent, use role-descriptive names to distinguish them.

**Discriminator columns** use `Type` or `Status`:

    [Type]           -- which subtype (bracketed because Type is a reserved word)
    [Status]         -- lifecycle state

---

## Views

Views follow the pattern `Role_Intent_V`:

    Staff_CommunityNote_V       -- Staff role, community notes
    Manager_TeamReport_V        -- Manager role, team report
    Admin_AllCustomers_V        -- Admin role, all customers
    Customer_MyOrders_V         -- Customer role, their own orders
    Worker_PendingJobs_V        -- Background worker, pending jobs

The role prefix tells you which role has `GRANT SELECT` on this view. The `_V` suffix distinguishes views from tables at a glance.

**System/worker views** use the service account name as the role:

    Worker_Notification_V       -- worker service account

---

## Procedures

Procedures follow the pattern `Verb_Domain_{trx,utx,ut}`:

    Add_OrderLine_trx           -- transaction owner
    AddVehicle_utx              -- transaction participant
    FindCustomer_ut             -- utility (no transaction requirement)
    Modify_Notification_trx     -- modifies a notification
    Next_Notification_trx       -- claims next queue item
    AddOrModify_UnitType_trx    -- upsert pattern

**Never use SQL keywords as verbs.** The verb layer must stay distinct from SQL syntax:

| Instead of | Use |
|-----------|-----|
| `Create` | `Add` or `Open` |
| `Update` | `Modify` |
| `Delete` | `Remove` or `Close` |
| `Select` | `Get` or `Find` |
| `Insert` | `Add` |

**The suffix is the transaction contract:**

| Suffix | Meaning |
|--------|---------|
| `_trx` | Owns its transaction — validates `@@TRANCOUNT = 0` |
| `_utx` | Participates in caller's transaction — validates `@@TRANCOUNT > 0` |
| `_ut` | No transaction requirement |

**Transaction names match the procedure name** — `BEGIN TRANSACTION Add_OrderLine_trx` inside `Add_OrderLine_trx`.

---

## Functions

Functions always end with `_fn`:

    Account_IsType_fn           -- type discriminator check
    NextOrderNo_fn              -- max-plus-one key generation
    QueueIsProcessable_fn       -- state classification
    ColumnExists_fn             -- meta function for migrations
    RentalBasePriceAsOf_fn      -- point-in-time calculation
    GetDefaultConstraintName_fn -- utility lookup

**Function naming patterns by purpose:**

| Purpose | Pattern | Example |
|---------|---------|---------|
| Type check | `Entity_IsType_fn` | `Vehicle_IsType_fn` |
| Next key | `Next<Column>_fn` | `NextOrderNo_fn` |
| State classification | `QueueIs<State>_fn` | `QueueIsFinished_fn` |
| Meta (migration) | `<Object>Exists_fn` | `TableExists_fn`, `ColumnExists_fn` |
| Permission check | `Has<Scope>Permission_fn` | `HasCommunityPermission_fn` |

---

## Constraints

Constraints read as **business predicates** — natural-language statements about the relationship:

    -- Foreign keys: Subject_Relationship_Object
    CONSTRAINT Customer_Rents_Vehicle
    CONSTRAINT SavingsAccount_Is_Account
    CONSTRAINT Order_IsPlacedBy_Customer
    CONSTRAINT UnitLease_IsContractedBy_Unit

    -- Type discriminators: Subtype_IsType_Base
    CONSTRAINT Car_IsVehicleType
    CONSTRAINT ResetPassword_IsType_Notification

    -- Classification: Entity_IsClassifiedBy_TypeTable
    CONSTRAINT Account_IsClassifiedBy_AccountType
    CONSTRAINT Vehicle_IsClassifiedBy_VehicleType

    -- Business rules: Entity_MustHave_Rule
    CONSTRAINT Customer_MustHave_ValidEmail

    -- Uniqueness: Entity_Column_IsUnique
    CONSTRAINT Customer_Email_IsUnique

    -- Primary keys: PK_Table
    CONSTRAINT PK_Customer PRIMARY KEY

**Never use structural prefixes** like `FK_`, `CK_`, `UQ_` — they describe the mechanism, not the meaning. `Customer_Rents_Vehicle` tells you the business rule; `FK_Rental_Customer` tells you nothing.

---

## Custom Types

Domain-specific types are PascalCase nouns:

    Email            -- VARCHAR(100) NOT NULL
    ApiKey           -- VARCHAR(128) NOT NULL
    AccountNo        -- INT NOT NULL
    PartyNo          -- INT NOT NULL
    PhoneNumber      -- VARCHAR(31) NOT NULL

**Generic primitive types** are prefixed with underscore:

    _Timestamp       -- DATETIME2 NOT NULL
    _Bool            -- BIT NOT NULL
    _Int             -- INT NOT NULL
    _Type            -- VARCHAR(25) NOT NULL
    _Money           -- DECIMAL(18,2) NOT NULL
    _Date            -- DATE NOT NULL

The underscore prefix signals "this is a generic primitive, not a domain concept." `_Int` could be anything; `AccountNo` is specifically an account identifier.

---

## Parameters

Procedure and function parameters use `@PascalCase`, matching the column name they correspond to:

    @CustomerNo CustomerNo      -- matches Customer.CustomerNo
    @Status QueueState          -- matches the Status column's type
    @ScheduledFor _Timestamp    -- matches the ScheduledFor column
    @NoteNo _Int OUTPUT         -- OUTPUT parameters follow the same convention

---

## Indexes

Indexes follow `IX_Table_Columns`:

    IX_Customer_Email
    IX_Order_CustomerNo
    IX_UnitType_BasePrice_UnitType

This is the one place where a structural prefix (`IX_`) is used — because indexes are infrastructure, not business logic. They don't appear in error messages or constraint violations, so the predicate naming convention doesn't apply.

---

## Abbreviations

**Avoid abbreviations** unless the abbreviation is more widely understood than the full word:

    -- Good: universally understood abbreviations
    No          -- Number (CustomerNo, OrderNo)
    ID          -- Identifier (when from an external system: EntrataID)
    OTP         -- One-Time Password
    DBA         -- Doing Business As

    -- Bad: ambiguous abbreviations
    Cust        -- Customer (just write Customer)
    Addr        -- Address (just write Address)
    Desc        -- Description or Descending? (just write Description)
    Num         -- Number (use No instead)
    Qty         -- Quantity (just write Quantity)

**When in doubt, spell it out.** Column names are read far more often than they're typed. The extra characters cost nothing; the ambiguity costs debugging time.

**The `No` vs `ID` convention:** Use `No` for internally generated sequential identifiers (`CustomerNo`, `OrderNo`). Use `ID` for identifiers that come from an external system (`EntrataID`, `DbUserID`). This signals at a glance whether the value is yours or someone else's.

---

## See Also

- [Procedure Structure](procedure-structure.md) — full `_trx` / `_utx` / `_ut` templates showing naming in context
- [Hierarchical Composite Keys](hierarchical-keys.md) — `Next<Column>_fn` naming for max-plus-one functions
- [Error Handling](error-handling.md) — error code naming (`EXIT_NOT_FOUND`, `EXIT_CANT_ADD`)

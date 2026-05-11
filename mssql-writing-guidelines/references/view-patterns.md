# View Patterns


Views are the read API. They are role-scoped, can enforce row-level security, and abstract away table structure.

## Table of Contents

- [Simple View](#simple-view)
- [Row-Level Security](#row-level-security)
- [String Aggregation](#string-aggregation)
- [Latest-Record Subqueries](#latest-record-subqueries)
- [Complex View (Full Example)](#complex-view-full-example)

---

## Simple View

Minimal view with no joins or security filters. Used for global settings or reference data.

    CREATE OR ALTER VIEW Admin_SystemSettings_V AS
    SELECT
        MaintenanceMode,
        MaxLoginAttempts,
        SessionTimeoutSecs,
        EnableRegistration
    FROM SystemSettings;

---

## Row-Level Security

Views that return user- or scope-restricted data include a WHERE clause enforcing access. Privileged system accounts bypass the filter; everyone else sees only what they own or are assigned to.

    CREATE OR ALTER VIEW Customer_MyOrders_V AS
    SELECT
        O.OrderNo,
        O.OrderDate,
        O.TotalAmount,
        O.[Status]
    FROM [Order] O
    WHERE
        -- System accounts see everything
        USER_NAME() IN ('__sysadmin', 'dbo', '__worker')
        OR IS_ROLEMEMBER('db_securityadmin') = 1
        -- Regular users see only their own data
        OR O.CustomerID = USER_ID();

For scope-based security (e.g., a manager sees data for their assigned region):

    WHERE
        USER_NAME() IN ('__sysadmin', 'dbo', '__worker')
        OR IS_ROLEMEMBER('db_securityadmin') = 1
        OR R.RegionNo IN (
            SELECT RegionNo FROM Region_Manager
            WHERE ManagerID = USER_ID()
        );

---

## String Aggregation

Use `STRING_AGG` to concatenate related rows into a comma-separated string:

    STRING_AGG(T.TagName, ', ') WITHIN GROUP (ORDER BY T.TagName) AS Tags

**Legacy (SQL Server 2016 and earlier):** use `FOR XML PATH('')` with `STUFF()` — see [Query Patterns](query-patterns.md#string-aggregation) for the full comparison.

---

## Latest-Record Subqueries

Use `OUTER APPLY` with `TOP 1 ... ORDER BY DESC` to fetch the most recent related record:

    OUTER APPLY (
        SELECT TOP 1
            SH.ChangedAt,
            SH.OldStatus,
            SH.NewStatus
        FROM StatusHistory SH
        WHERE SH.OrderNo = O.OrderNo
        ORDER BY SH.ChangedAt DESC
    ) LatestStatus

Use `OUTER APPLY` (not `CROSS APPLY`) so the main row is preserved even when no matching record exists — the subquery columns will be NULL.

---

## Complex View (Full Example)

Combines joins, OUTER APPLY, CASE mapping, string aggregation, and row-level security:

    CREATE OR ALTER VIEW Manager_OrderSummary_V AS
    SELECT
        O.OrderNo,
        O.OrderDate,

        -- Customer info via JOIN
        C.FullName AS CustomerName,
        C.Email AS CustomerEmail,

        -- Region info
        R.[Name] AS RegionName,

        -- Latest status via OUTER APPLY
        LS.NewStatus AS CurrentStatus,
        LS.ChangedAt AS LastStatusChange,

        -- Financial
        O.SubTotal,
        O.TaxAmount,
        O.TotalAmount,

        -- Status display mapping
        CASE
            WHEN O.[Status] IN ('Submitted', 'Confirmed') THEN 'Active'
            WHEN O.[Status] IN ('Shipped', 'Delivered') THEN 'Fulfilled'
            WHEN O.[Status] = 'Cancelled' THEN 'Cancelled'
            ELSE 'Unknown'
        END AS StatusGroup,

        -- Aggregated item names
        STUFF((
            SELECT ', ' + I.ProductName
            FROM OrderItem OI
            INNER JOIN Inventory I ON OI.ProductNo = I.ProductNo
            WHERE OI.OrderNo = O.OrderNo
            ORDER BY I.ProductName
            FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS ItemList

    FROM [Order] O

    OUTER APPLY (
        SELECT TOP 1 SH.NewStatus, SH.ChangedAt
        FROM StatusHistory SH
        WHERE SH.OrderNo = O.OrderNo
        ORDER BY SH.ChangedAt DESC
    ) LS

    INNER JOIN Customer C ON O.CustomerNo = C.CustomerNo
    INNER JOIN Region R ON O.RegionNo = R.RegionNo

    WHERE
        USER_NAME() IN ('__sysadmin', 'dbo', '__worker')
        OR IS_ROLEMEMBER('db_securityadmin') = 1
        OR R.RegionNo IN (
            SELECT RegionNo FROM Region_Manager
            WHERE ManagerID = USER_ID()
        );

---

## See Also

- [Security & Permissions](security-permissions.md) — the security model where each app user is a real database principal, enabling `USER_NAME()`, `DATABASE_PRINCIPAL_ID()`, and `IS_ROLEMEMBER()` in view filters
- [Base/Subtype Inheritance](basetype-subtype.md) — views over subtypes (INNER JOIN for specific, LEFT JOIN for unified)
- [Query Patterns](query-patterns.md) — SARGability, window functions, CROSS APPLY, and STRING_AGG patterns used in views

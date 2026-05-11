# Security Model: Users, Roles, and Permissions


The entire access control architecture depends on one foundational decision: application users are real database users. This is not a metaphor — every human who authenticates in the application gets a corresponding SQL Server login and database user. This is what makes `USER_NAME()`, `USER_ID()`, and `IS_ROLEMEMBER()` work in views. The database knows who is asking.

## Table of Contents

- [Application Users as Database Users](#application-users-as-database-users)
- [Roles, Not Direct Permissions](#roles-not-direct-permissions)
- [Granular Permissions by Object Type](#granular-permissions-by-object-type)
- [Service Accounts](#service-accounts)
- [Centralized Permission Manifest](#centralized-permission-manifest)
- [How It All Connects](#how-it-all-connects)

---

## Application Users as Database Users

When a new user registers in the application, the backend creates a SQL Server login and database user for them:

    -- Create a server-level login
    CREATE LOGIN [jane.doe] WITH PASSWORD = 'generated-credential';

    -- Create a database user mapped to that login
    CREATE USER [jane.doe] FOR LOGIN [jane.doe];

From this point forward, queries executed on behalf of Jane run as her database user. Every view's `USER_NAME()` returns `jane.doe`, every `USER_ID()` returns her database principal ID, and `IS_ROLEMEMBER('Staff')` returns 1 if she's been added to the Staff role.

This is the mechanism that makes row-level security in views work natively — not through application-layer filtering, but through the database engine itself.

---

## Roles, Not Direct Permissions

Permissions are never granted directly to users. They are granted to **roles**, and users are added as members of those roles:

    -- Define roles that map to application responsibilities
    CREATE ROLE [Staff];
    CREATE ROLE [PricingManager];
    CREATE ROLE [LegalAdmin];
    CREATE ROLE [AppAdmin];
    CREATE ROLE [WebApp];
    CREATE ROLE [WorkerCommon];
    CREATE ROLE [WorkerPrivileged];

    -- Add a user to a role (done by the application when roles are assigned)
    ALTER ROLE [Staff] ADD MEMBER [jane.doe];
    ALTER ROLE [PricingManager] ADD MEMBER [jane.doe];

A user's effective permissions are the union of all their roles' permissions. Jane, as both Staff and PricingManager, can access all views and procedures granted to either role.

Removing access is just as clean:

    ALTER ROLE [PricingManager] DROP MEMBER [jane.doe];

Jane immediately loses all PricingManager permissions. No scattered `REVOKE` statements, no permission audits — role membership is the single control point.

---

## Granular Permissions by Object Type

Roles get `SELECT` on views and `EXECUTE` on procedures and functions — never direct table access:

    -- Views: the role can read this data
    GRANT SELECT ON [Staff_UnitLease_V] TO [Staff];
    GRANT SELECT ON [Staff_UnitType_V] TO [Staff];

    -- Procedures: the role can perform these mutations
    GRANT EXECUTE ON [Add_LeaseNote_trx] TO [PricingManager];
    GRANT EXECUTE ON [Add_UnitType_GrowthRate_trx] TO [PricingManager];

    -- Functions: the role can call these
    GRANT EXECUTE ON [RentalBasePriceAsOf_fn] TO [PricingManager];

No role ever receives `SELECT`, `INSERT`, `UPDATE`, or `DELETE` on a table directly. This is what enforces the two access rules at the database level — not by convention, but by the permission system itself. If a role doesn't have `GRANT SELECT` on a view, that role cannot read that data. If it doesn't have `GRANT EXECUTE` on a procedure, it cannot perform that mutation.

---

## Service Accounts

Backend services (web servers, background workers) connect through dedicated service accounts. These are SQL Server logins just like application users, but they represent processes, not people:

    -- Service accounts are logins with environment-supplied passwords
    CREATE LOGIN [__web_app] WITH PASSWORD = '$(DB_WEB_APP_PASSWORD)';
    CREATE LOGIN [__worker_common] WITH PASSWORD = '$(DB_WORKER_COMMON_PASSWORD)';
    CREATE LOGIN [__worker_privileged] WITH PASSWORD = '$(DB_WORKER_PRIVILEGED_PASSWORD)';

    -- Create database users for each
    CREATE USER [__web_app] FOR LOGIN [__web_app];
    CREATE USER [__worker_common] FOR LOGIN [__worker_common];

    -- Service accounts are members of roles, just like users
    ALTER ROLE [WebApp] ADD MEMBER [__web_app];
    ALTER ROLE [WorkerCommon] ADD MEMBER [__worker_common];

Service accounts follow the same rule: no direct permissions, only role membership. The `WebApp` role gets access to public auth views and login procedures. The `WorkerCommon` role gets access to background job views and queue procedures. Each service account can only do what its role allows.

In views with row-level security, service accounts are typically included in the bypass list since they act on behalf of the system, not a specific user:

    WHERE
        USER_NAME() IN ('__app_sysadmin', 'dbo', '__worker_privileged', '__worker_common')
        OR IS_ROLEMEMBER('db_securityadmin') = 1
        OR ...

---

## Centralized Permission Manifest

Maintain a single manifest file (YAML or similar) that provides a bird's-eye view of the entire security surface. This manifest is the source of truth and is compiled into SQL during deployment. The structure:

    users:
        - username: __web_app
          password: $DB_WEB_APP_PASSWORD
        - username: __worker_common
          password: $DB_WORKER_COMMON_PASSWORD

    roles:
        - WebApp
        - Staff
        - PricingManager
        - LegalAdmin
        - AppAdmin
        - WorkerCommon
        - WorkerPrivileged

    permissions:
        Staff:
            Views:
                - Staff_UnitLease_V
                - Staff_UnitType_V
                - Staff_Unit_V
            Procs: []

        PricingManager:
            Views:
                - PricingManager_Community_V
                - PricingManager_UnitType_V
            Procs:
                - Add_UnitType_GrowthRate_trx
                - Add_Community_GrowthRate_trx
            Functions:
                - RentalBasePriceAsOf_fn

        WebApp:
            Members:
                - __web_app
            Views:
                - Web_AuthSettings_V
            Procs:
                - Login_trx
                - SignUp_trx
                - CreateSession_trx

The benefits of centralization:

- **Auditability** — the entire security surface is visible in one file. You can diff it across deployments.
- **New object onboarding** — when you create a new view or procedure, you add it to the manifest under the appropriate role. If it's not in the manifest, no role can access it.
- **No scattered GRANTs** — the manifest compiles into all the `GRANT SELECT`, `GRANT EXECUTE`, and `ALTER ROLE ADD MEMBER` statements. Individual SQL files never contain permission statements.

---

## How It All Connects

The security model ties together every other pattern in this methodology:

1. **Views are the read API** → roles get `GRANT SELECT` on specific views
2. **Procedures are the write API** → roles get `GRANT EXECUTE` on specific procedures
3. **No direct table access** → enforced by never granting table-level permissions to any role
4. **Row-level security in views** → works because `USER_ID()` and `IS_ROLEMEMBER()` reflect real database principals
5. **Role-scoped view naming** (`Staff_`, `Admin_`, `Customer_`) → the prefix tells you which role has access
6. **Constraint naming as predicates** → constraint violations in error logs are readable because the security and business layers share the same language

The security boundary lives where the data lives. The application cannot bypass it.

---

## See Also

- [View Patterns](view-patterns.md) — role-scoped views with row-level security WHERE clauses
- [Procedure Structure](procedure-structure.md) — procedures that roles get `GRANT EXECUTE` on

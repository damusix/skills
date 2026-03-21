# Application Settings


A centralized control table for application-wide configuration. Rather than hardcoding values in procedures or scattering per-feature settings tables across the schema, a single `AppSettings` table provides a queryable, auditable home for all runtime parameters.

## Table of Contents

- [The Table](#the-table)
- [Seeding Settings](#seeding-settings)
- [Reading Settings in Procedures](#reading-settings-in-procedures)
- [Naming Conventions](#naming-conventions)

---

## The Table

    CREATE TABLE AppSettings (
        Param Name PRIMARY KEY,
        ValBool _Bool DEFAULT 0,
        ValInt _Int DEFAULT 0,
        ValFloat FLOAT DEFAULT 0,
        ValStr Description DEFAULT ''
    );

Every row is a named parameter with typed value columns. A given parameter uses one column and ignores the rest (which fall to their defaults). `FLOAT` is the one bare built-in type here — `AppSettings` is a utility table, not a domain table, so a domain-specific float type would be misleading.

All value columns are NOT NULL with defaults. The rule applies universally — even for a utility table, NULLs introduce ambiguity. A parameter that hasn't been explicitly set reads as `0` or `''`, not NULL.

---

## Seeding Settings

Seed known configuration immediately in the DDL script, grouped by namespace:

    INSERT INTO AppSettings (Param, ValInt) VALUES
        ('notification.maxAttempts', 3),
        ('notification.rescheduleBackoff', 60),
        ('smtp.port', 1025);

    INSERT INTO AppSettings (Param, ValStr) VALUES
        ('smtp.host', 'localhost');

    INSERT INTO AppSettings (Param, ValBool) VALUES
        ('feature.emailEnabled', 1),
        ('feature.smsEnabled', 0);

This follows the same principle as reference tables — if the values are known at design time, they belong in the schema definition.

---

## Reading Settings in Procedures

Always read from the appropriately typed column and wrap in `COALESCE` with a sane default:

    -- Integer setting
    SET @MaxAttempts = COALESCE(
        (SELECT ValInt FROM AppSettings WHERE Param = 'notification.maxAttempts'),
        3
    );

    -- String setting
    SET @SmtpHost = COALESCE(
        (SELECT ValStr FROM AppSettings WHERE Param = 'smtp.host'),
        'localhost'
    );

    -- Boolean setting
    SET @EmailEnabled = COALESCE(
        (SELECT ValBool FROM AppSettings WHERE Param = 'feature.emailEnabled'),
        1
    );

The `COALESCE` default ensures the system behaves sanely even if a setting hasn't been configured yet. This makes procedures resilient to missing configuration without failing silently.

Use the typed column directly — `ValInt` for integers, `ValStr` for strings, `ValBool` for flags. Never cast between columns (e.g., casting `ValStr` to INT when `ValInt` exists).

---

## Naming Conventions

Use dot-separated namespaces to organize parameters:

    notification.maxAttempts
    notification.rescheduleBackoff
    smtp.host
    smtp.port
    feature.emailEnabled
    sync.batchSize
    sync.timeoutMs

The namespace groups related settings so they're discoverable. You can query all settings for a subsystem:

    SELECT * FROM AppSettings WHERE Param LIKE 'notification.%';

This pattern scales cleanly — adding a new subsystem is just adding rows with a new namespace prefix, not creating a new table.

---

## See Also

- [Relational Queues](relational-queues.md) — queue procedures read max attempts and backoff intervals from AppSettings

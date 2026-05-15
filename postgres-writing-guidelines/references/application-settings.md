# Application Settings


A centralized `app_settings` table for runtime configuration — max retry attempts, feature flags, service endpoints, batch sizes. Single queryable, auditable home for runtime parameters with typed columns and dot-namespaced keys.

## Table of Contents

- [Table Shape](#table-shape)
- [Naming Convention](#naming-convention)
- [Seeding](#seeding)
- [Reading from Functions and Procedures](#reading-from-functions-and-procedures)
- [Writing](#writing)
- [Postgres GUC Custom Params](#postgres-guc-custom-params)

---

## Table Shape

    CREATE DOMAIN param_name AS varchar(80) NOT NULL
        CHECK (VALUE ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$');

    CREATE TABLE app_settings (
        param      param_name PRIMARY KEY,
        val_bool   boolean              NOT NULL DEFAULT FALSE,
        val_int    bigint               NOT NULL DEFAULT 0,
        val_float  double precision     NOT NULL DEFAULT 0,
        val_str    text                 NOT NULL DEFAULT '',
        notes      text                 NOT NULL DEFAULT '',
        updated_at ts_now               NOT NULL,
        updated_by user_id
    );

One row per setting. The four typed columns let you store any primitive without polymorphic gymnastics — readers know which column to use because they know what the setting is.

## Naming Convention

Dot-separated namespaces, lowercase, snake within segments:

    notification.max_attempts
    notification.base_backoff_seconds
    notification.email_enabled
    smtp.host
    smtp.port
    feature.new_dashboard
    queue.poll_interval_ms

Group by subsystem in the leading segment. Use clear types in the trailing segment (`_seconds`, `_ms`, `_count`, `_enabled`) so the column to read is obvious.

## Seeding

Add new settings idempotently in migrations:

    INSERT INTO app_settings(param, val_int, notes) VALUES
        ('notification.max_attempts',          5,    'max retries before failed'),
        ('notification.base_backoff_seconds',  60,   'exponential backoff base'),
        ('queue.poll_interval_ms',             5000, 'worker poll cadence')
    ON CONFLICT (param) DO NOTHING;  -- preserve manual overrides

    INSERT INTO app_settings(param, val_bool, notes) VALUES
        ('notification.email_enabled', TRUE,  'master switch for email channel'),
        ('feature.new_dashboard',      FALSE, 'gradual rollout flag')
    ON CONFLICT (param) DO NOTHING;

`ON CONFLICT DO NOTHING` ensures reseeding doesn't clobber operational changes.

## Reading from Functions and Procedures

Always wrap reads in `COALESCE` with a sane default — the system must work even if a setting is missing:

    -- Inside a function
    DECLARE
        v_max_attempts smallint := COALESCE(
            (SELECT val_int FROM app_settings WHERE param = 'notification.max_attempts'),
            5  -- fallback if not configured
        )::smallint;

A small helper for hot paths:

    CREATE OR REPLACE FUNCTION fn_setting_int(p_param param_name, p_default bigint)
    RETURNS bigint LANGUAGE sql STABLE AS $$
        SELECT COALESCE(
            (SELECT val_int FROM app_settings WHERE param = p_param),
            p_default
        );
    $$;

    CREATE OR REPLACE FUNCTION fn_setting_bool(p_param param_name, p_default boolean)
    RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT COALESCE(
            (SELECT val_bool FROM app_settings WHERE param = p_param),
            p_default
        );
    $$;

Use:

    IF fn_setting_bool('notification.email_enabled', TRUE) THEN
        ...
    END IF;

`STABLE` lets Postgres cache the value within a single query, so multiple reads of the same setting cost one lookup.

## Writing

Modify settings via a procedure so writes are auditable:

    CREATE OR REPLACE PROCEDURE pr_modify_app_setting_int(
        p_param param_name,
        p_value bigint,
        p_notes text DEFAULT NULL
    )
    LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM fn_assert_not_in_transaction();

        INSERT INTO app_settings(param, val_int, notes, updated_by)
        VALUES (p_param, p_value, COALESCE(p_notes, ''), fn_current_app_user_id())
        ON CONFLICT (param) DO UPDATE SET
            val_int    = EXCLUDED.val_int,
            notes      = COALESCE(EXCLUDED.notes, app_settings.notes),
            updated_at = clock_timestamp(),
            updated_by = EXCLUDED.updated_by;

        COMMIT;
    EXCEPTION WHEN OTHERS THEN
        ROLLBACK;
        RAISE;
    END;
    $$;

Restrict EXECUTE to operator roles via RLS or `REVOKE EXECUTE ... FROM PUBLIC; GRANT EXECUTE ... TO ops_role;`.

## Postgres GUC Custom Params

Postgres has a built-in mechanism for *session-scoped* config: GUC custom params (`SET app.foo = 'bar'`, read with `current_setting('app.foo', TRUE)`). Use these for:

- Per-connection identity (`SET app.user_id = ...` for RLS — see [Row-Level Security](row-level-security.md))
- Feature flag overrides for a single session (debugging)
- Anything that must vary per-request without a DB write

Don't use GUC custom params for global runtime config — they're per-session by default and don't persist. The `app_settings` table is the source of truth; GUC params are for dynamic per-request context.

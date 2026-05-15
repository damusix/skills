# Relational Queues


Postgres queue tables use `SELECT ... FOR UPDATE SKIP LOCKED` for atomic concurrent claim. Optionally augment with `LISTEN`/`NOTIFY` for low-latency wake-up so workers don't have to poll.

## Table of Contents

- [Queue Table Shape](#queue-table-shape)
- [Status State Machine](#status-state-machine)
- [Atomic Claim with FOR UPDATE SKIP LOCKED](#atomic-claim-with-for-update-skip-locked)
- [LISTEN/NOTIFY for Low-Latency Wake](#listennotify-for-low-latency-wake)
- [Reporting Results](#reporting-results)
- [Max Attempts and Backoff](#max-attempts-and-backoff)
- [Step Tracking for Resumable Jobs](#step-tracking-for-resumable-jobs)
- [Queues as Base/Subtypes](#queues-as-basesubtypes)
- [Cleanup and Archival](#cleanup-and-archival)

---

## Queue Table Shape

A queue table mixes **domain columns** (the work to do) with **queue lifecycle columns** (state machine, attempts, timestamps). Keep the queue columns visually grouped:

    CREATE TABLE notification_queue (
        -- Domain columns
        notification_id    bigserial PRIMARY KEY,
        recipient_user_id  user_id NOT NULL,
        channel            channel_enum NOT NULL,    -- 'email', 'sms', 'push'
        subject            text NOT NULL,
        body               text NOT NULL,
        payload            jsonb NOT NULL DEFAULT '{}'::jsonb,

        -- Queue lifecycle columns
        status             queue_status NOT NULL DEFAULT 'pending',
        step               queue_step NOT NULL DEFAULT 'init',
        attempt_num        smallint NOT NULL DEFAULT 0,
        scheduled_for      ts_now NOT NULL,
        started_at         timestamptz,
        finished_at        timestamptz,
        duration_ms        integer,
        response           jsonb,
        error              text,
        created_at         ts_now NOT NULL,
        updated_at         ts_now NOT NULL
    );

    CREATE INDEX notification_queue_claim_idx
        ON notification_queue (status, scheduled_for)
        WHERE status IN ('pending', 'retry');

The partial index makes claim queries cheap — they only scan claimable rows.

## Status State Machine

A shared reference table defines the vocabulary so every queue table speaks the same language:

    CREATE TABLE queue_status (
        status      queue_status PRIMARY KEY,
        is_terminal boolean NOT NULL,
        is_claimable boolean NOT NULL
    );

    INSERT INTO queue_status VALUES
        ('pending',     FALSE, TRUE),
        ('in_progress', FALSE, FALSE),
        ('retry',       FALSE, TRUE),
        ('done',        TRUE,  FALSE),
        ('failed',      TRUE,  FALSE),
        ('cancelled',   TRUE,  FALSE)
    ON CONFLICT DO NOTHING;

Helper function:

    CREATE OR REPLACE FUNCTION fn_queue_status_is_terminal(p_status queue_status)
    RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT is_terminal FROM queue_status WHERE status = p_status;
    $$;

## Atomic Claim with FOR UPDATE SKIP LOCKED

Workers claim the next available item with one round trip — no race conditions, no double-processing:

    CREATE OR REPLACE FUNCTION fn_next_notification_to_send(p_max_attempts smallint DEFAULT NULL)
    RETURNS SETOF notification_queue
    LANGUAGE plpgsql AS $$
    DECLARE
        v_max smallint := COALESCE(
            p_max_attempts,
            (SELECT val_int::smallint FROM app_settings WHERE param = 'notification.max_attempts'),
            5
        );
    BEGIN
        RETURN QUERY
        WITH claimed AS (
            SELECT notification_id FROM notification_queue
            WHERE status IN ('pending', 'retry')
              AND scheduled_for <= clock_timestamp()
              AND attempt_num < v_max
            ORDER BY scheduled_for
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE notification_queue q
        SET status      = 'in_progress',
            started_at  = clock_timestamp(),
            attempt_num = q.attempt_num + 1,
            updated_at  = clock_timestamp()
        FROM claimed
        WHERE q.notification_id = claimed.notification_id
        RETURNING q.*;
    END;
    $$;

`SKIP LOCKED` makes concurrent workers skip rows other workers have locked. `LIMIT 1` claims one item at a time. The `WITH ... UPDATE ... RETURNING` pattern combines selection and state transition atomically.

For batch claim (multiple items per worker call), change `LIMIT 1` to `LIMIT N`.

## LISTEN/NOTIFY for Low-Latency Wake

Polling every N seconds wastes resources. `LISTEN`/`NOTIFY` lets producers wake workers immediately:

    -- Producer (after enqueue)
    CREATE OR REPLACE FUNCTION tg_notify_queue()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM pg_notify('notification_queue', NEW.notification_id::text);
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER notification_queue_notify
        AFTER INSERT ON notification_queue
        FOR EACH ROW EXECUTE FUNCTION tg_notify_queue();

    -- Worker (in client code)
    LISTEN notification_queue;
    -- block on next NOTIFY, then call fn_next_notification_to_send()

The worker still polls periodically (every minute or so) as a safety net for missed notifications, retries, and scheduled-for-future jobs. NOTIFY is an optimization, not a guarantee.

## Reporting Results

After processing, the worker reports outcome via a procedure that enforces the state machine and writes optimistically:

    CREATE OR REPLACE PROCEDURE pr_modify_notification_result(
        p_notification_id bigint,
        p_attempt_num     smallint,
        p_status          queue_status,
        p_response        jsonb DEFAULT NULL,
        p_error           text  DEFAULT NULL
    )
    LANGUAGE plpgsql AS $$
    DECLARE
        v_current_status queue_status;
        v_current_attempt smallint;
    BEGIN
        PERFORM fn_assert_not_in_transaction();

        SELECT status, attempt_num
            INTO v_current_status, v_current_attempt
        FROM notification_queue WHERE notification_id = p_notification_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'notification % not found', p_notification_id
                USING ERRCODE = 'P0002';
        END IF;

        -- Optimistic concurrency: caller must have the attempt they claimed
        IF v_current_attempt <> p_attempt_num THEN
            RAISE EXCEPTION 'attempt mismatch: caller has %, current is %',
                    p_attempt_num, v_current_attempt
                USING ERRCODE = 'P0013';
        END IF;

        IF v_current_status <> 'in_progress' THEN
            RAISE EXCEPTION 'cannot report result for non-running job (status=%)',
                    v_current_status
                USING ERRCODE = 'P0005';
        END IF;

        UPDATE notification_queue
        SET status      = p_status,
            response    = p_response,
            error       = p_error,
            finished_at = clock_timestamp(),
            duration_ms = EXTRACT(MILLISECONDS FROM clock_timestamp() - started_at)::integer,
            updated_at  = clock_timestamp(),
            scheduled_for = CASE
                WHEN p_status = 'retry'
                THEN clock_timestamp() + (POWER(2, attempt_num) * INTERVAL '1 minute')
                ELSE scheduled_for
            END
        WHERE notification_id = p_notification_id;

        COMMIT;
    EXCEPTION WHEN OTHERS THEN
        ROLLBACK;
        RAISE;
    END;
    $$;

## Max Attempts and Backoff

Read max attempts from `app_settings`:

    INSERT INTO app_settings(param, val_int) VALUES
        ('notification.max_attempts', 5),
        ('notification.base_backoff_seconds', 60)
    ON CONFLICT DO NOTHING;

Apply exponential backoff in the result-reporting procedure (see above): `2^attempt_num * base_backoff`. Cap with `LEAST(...)` if you want a ceiling.

When `attempt_num >= max_attempts`, transition to `failed` rather than `retry` — the claim function's `attempt_num < v_max` predicate already filters exhausted jobs out, but explicit terminal status is clearer in the audit trail.

## Step Tracking for Resumable Jobs

Multi-step jobs (e.g., "render PDF → upload → email link") track progress so a retry can resume rather than restart:

    CREATE TYPE notification_step AS ENUM (
        'init', 'rendered', 'uploaded', 'sent'
    );

    -- In the worker, after each step:
    UPDATE notification_queue
    SET step = 'rendered', updated_at = clock_timestamp()
    WHERE notification_id = p_notification_id;

On retry, the worker reads `step` and resumes from the next stage. Workers must be idempotent across step boundaries — restarting a step that partially completed must not double-side-effect.

## Queues as Base/Subtypes

When you have multiple queue types that share lifecycle but differ in payload, model them as base/subtype:

    -- Base table: lifecycle columns shared by all queue types
    CREATE TABLE queue_item (
        queue_item_id  bigserial PRIMARY KEY,
        type           queue_item_type NOT NULL,
        status         queue_status NOT NULL DEFAULT 'pending',
        attempt_num    smallint NOT NULL DEFAULT 0,
        scheduled_for  ts_now NOT NULL,
        ...
    );

    -- Subtype: notification-specific payload
    CREATE TABLE notification_queue_item (
        queue_item_id     bigint PRIMARY KEY,
        recipient_user_id user_id NOT NULL,
        channel           channel_enum NOT NULL,
        subject           text NOT NULL,
        body              text NOT NULL,

        CONSTRAINT notification_queue_item_is_queue_item
            FOREIGN KEY (queue_item_id) REFERENCES queue_item(queue_item_id)
                ON DELETE CASCADE
    );

    -- Type discriminator trigger (see Cross-Table Constraints)

Now `fn_next_*_to_process` for any queue type joins base + subtype and applies the same claim pattern.

## Cleanup and Archival

Terminal jobs (`done`, `failed`, `cancelled`) accumulate. Periodically archive or purge:

    -- Archive jobs older than 30 days
    WITH archived AS (
        DELETE FROM notification_queue
        WHERE status IN ('done', 'failed', 'cancelled')
          AND finished_at < clock_timestamp() - INTERVAL '30 days'
        RETURNING *
    )
    INSERT INTO notification_archive SELECT * FROM archived;

Schedule via cron, pg_cron extension, or a worker that runs the cleanup procedure on a fixed interval.

# Relational Queues


Tables that carry queue semantics alongside their relational data. A notification is both a domain record (who gets notified, through which channel, with what content) and a work item (pending, processing, retry on error, completed). The queue columns track the lifecycle of the work; the domain columns describe the work itself.

## Table of Contents

- [Queue Shape](#queue-shape)
- [Queue Status Reference Table](#queue-status-reference-table)
- [State Classification Functions](#state-classification-functions)
- [The Next Procedure — Atomic Claim](#the-next-procedure--atomic-claim)
- [The Modify Procedure — State Machine](#the-modify-procedure--state-machine)
- [Queues as Base/Subtype](#queues-as-basesubtype)

---

## Queue Shape

Every relational queue table includes these columns alongside its domain-specific data. These columns track the lifecycle of the work item, not the lifecycle of the record itself — they are distinct from any `CreatedAt` / `UpdatedAt` on the entity:

| Column | Type | Purpose |
|--------|------|---------|
| `Status` | `QueueState` | Current state: Pending, Processing, Error, Completed, etc. |
| `Step` | `QueueStep` | Current step in a multi-step job (e.g., 'Validate', 'Send', 'Confirm') |
| `AttemptNum` | `AttemptNum` | How many times this item has been processed (increments on each retry) |
| `Response` | `WebResponse` | Response body from an external call (SMTP, API, webhook) |
| `Error` | `WebResponse` | Error message or body from a failed attempt |
| `StartedAt` | `_Timestamp` | When the current processing attempt began |
| `Duration` | `Duration` | Milliseconds elapsed from StartedAt to completion |
| `ScheduledFor` | `_Timestamp` | Earliest time this item should be picked up (enables backoff/scheduling) |
| `UpdatedAt` | `_Timestamp` | Last modification to queue state (used for optimistic concurrency) |

`Step` tracks where a multi-step job left off. A notification worker might progress through steps like `Render → Send → Confirm`. If the job fails at `Send`, the worker can resume from that step on retry instead of starting over. For single-step jobs, `Step` can default to the first step or be omitted.

Example — a sync queue:

    CREATE TABLE SyncQueue (
        EnqueuedAt _Timestamp,
        UpdatedAt _Timestamp,

        [Status] QueueState,
        [Type] _Type,
        [Step] QueueStep,
        AttemptNum AttemptNum,
        Response WebResponse DEFAULT '',
        Error WebResponse DEFAULT '',
        StartedAt _Timestamp,
        Duration Duration,
        ScheduledFor _Timestamp,

        CONSTRAINT PK_SyncQueue PRIMARY KEY (EnqueuedAt),

        CONSTRAINT SyncQueue_IsClassifiedBy_SyncQueueType
            FOREIGN KEY ([Type])
            REFERENCES SyncQueueType([Type]),

        CONSTRAINT SyncQueue_IsStatedBy_QueueStatus
            FOREIGN KEY ([Status])
            REFERENCES QueueStatus([Status])
    );

The `Type` column with its FK to a type reference table allows a single queue to serve multiple job types — all sharing the same lifecycle columns.

---

## Queue Status Reference Table

Define a shared status vocabulary used across all queues. Seed it immediately:

    CREATE TABLE QueueStatus (
        [Status] QueueState,

        CONSTRAINT PK_QueueStatus PRIMARY KEY CLUSTERED ([Status])
    );

    INSERT INTO QueueStatus([Status]) VALUES
        ('Pending'),
        ('Processing'),
        ('Error'),           -- Retryable
        ('Failed'),          -- Non-retryable (max attempts exceeded)
        ('Completed'),
        ('Cancelled'),
        ('Paused'),
        ('Terminated'),
        ('PartiallyCompleted');

The states form a lifecycle: `Pending → Processing → Completed/Error/Failed`. `Error` items re-enter `Processing` on retry. `Failed` is terminal — the item has exhausted its retry budget.

---

## State Classification Functions

Rather than scattering status checks across procedures, centralize them in functions that classify a status into categories. These make the state machine explicit and reusable:

    CREATE OR ALTER FUNCTION QueueIsProcessable_fn (@Status QueueState)
    RETURNS BIT AS BEGIN
        -- Can this item be picked up for processing?
        IF @Status IN ('Pending', 'Paused', 'Error')
            RETURN 1;
        RETURN 0;
    END;

    CREATE OR ALTER FUNCTION QueueIsFinished_fn (@Status QueueState)
    RETURNS BIT AS BEGIN
        -- Is this item in a terminal state?
        IF @Status NOT IN ('Pending', 'Processing', 'Error', 'Paused')
            RETURN 1;
        RETURN 0;
    END;

    CREATE OR ALTER FUNCTION QueueIsEditable_fn (@Status QueueState)
    RETURNS BIT AS BEGIN
        -- Can a worker write response/error data to this item?
        IF @Status NOT IN ('Cancelled', 'Paused', 'Terminated', 'Completed', 'PartiallyCompleted')
            RETURN 1;
        RETURN 0;
    END;

Using these in procedures: `IF dbo.QueueIsFinished_fn(@CurrentStatus) = 1 GOTO EXIT_ERROR` — the intent is clear without memorizing which statuses are terminal.

---

## The Next Procedure — Atomic Claim

The `Next_` procedure is called by a background worker to atomically claim the next available item. This is the critical concurrency pattern — multiple workers polling the same queue must not claim the same item.

Use `UPDLOCK, ROWLOCK, READPAST` on the `SELECT TOP 1`:

    CREATE OR ALTER PROCEDURE Next_Notification_trx
    AS BEGIN

        DECLARE @EnqueuedAt _Timestamp;
        DECLARE @MaxAttempts _Int;
        DECLARE @ErrNo INT;
        DECLARE @RowCnt INT;

        IF (@@TRANCOUNT > 0) BEGIN
            RAISERROR(50012, 16, 1, 'Next_Notification_trx');
            GOTO EXIT_ERROR;
        END

        -- Read max attempts from centralized settings, default to 3
        SET @MaxAttempts = COALESCE(
            (SELECT ValInt FROM AppSettings WHERE Param = 'notification.maxAttempts'),
            3
        );

        BEGIN TRANSACTION Next_Notification_trx;

            -- READPAST skips rows locked by other workers
            -- UPDLOCK + ROWLOCK claims this specific row
            SELECT TOP (1)
                @EnqueuedAt = EnqueuedAt
            FROM Notification WITH (UPDLOCK, ROWLOCK, READPAST)
            WHERE
                [Status] IN ('Pending', 'Error')
                AND ScheduledFor <= SYSDATETIME()
                AND AttemptNum < @MaxAttempts
            ORDER BY
                ScheduledFor ASC;

            -- No work available — clean exit
            IF @EnqueuedAt IS NULL BEGIN
                COMMIT TRANSACTION Next_Notification_trx;
                RETURN 0;
            END

            -- Claim the item: set to Processing, bump attempt count
            UPDATE Notification
            SET
                [Status] = 'Processing',
                UpdatedAt = SYSDATETIME(),
                StartedAt = SYSDATETIME(),
                AttemptNum = AttemptNum + 1
            WHERE
                EnqueuedAt = @EnqueuedAt;

            SELECT @RowCnt = @@ROWCOUNT, @ErrNo = @@ERROR;

            IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;
            IF (@RowCnt <> 1) BEGIN
                RAISERROR(50005, 16, 1, 'Next_Notification_trx: Notification');
                GOTO EXIT_TRANSACTION;
            END

        COMMIT TRANSACTION Next_Notification_trx;

        -- Return the claimed item's key and concurrency token
        SELECT EnqueuedAt, UpdatedAt FROM Worker_Notification_V
        WHERE EnqueuedAt = @EnqueuedAt;

        RETURN 0;

    EXIT_TRANSACTION:
        ROLLBACK TRANSACTION Next_Notification_trx;

    EXIT_ERROR:
        RETURN 1;

    END;

**Why `READPAST` matters:** Without it, `UPDLOCK` causes the second worker to *wait* until the first worker commits. With `READPAST`, the second worker *skips* the locked row and grabs the next one. This is the difference between serialized and concurrent queue consumption.

**MaxAttempts in the WHERE clause** filters out items that have exhausted their retry budget directly in the SELECT — they never get claimed. The `COALESCE` with a default of 3 ensures the queue works even if the setting hasn't been configured yet.

**Alternative — `UPDATE` with `OUTPUT`:** SQL Server supports an `OUTPUT` clause on UPDATE that can combine the SELECT-then-UPDATE into a single atomic statement: `UPDATE TOP (1) ... WITH (UPDLOCK, ROWLOCK, READPAST) SET Status = 'Processing', ... OUTPUT inserted.EnqueuedAt, inserted.UpdatedAt WHERE ...`. This eliminates the separate SELECT and the "no work available" check (an empty result set means no rows matched). The two-step pattern above is shown because it integrates cleanly with the 5-block procedure structure, but `UPDATE ... OUTPUT` is a valid simplification when the procedure's only job is claiming the next item.

**The SELECT after COMMIT** returns only the primary key and `UpdatedAt` (the optimistic concurrency token) through a worker-scoped view. The worker uses the PK to fetch full details from the view, and carries `UpdatedAt` into the subsequent `Modify_` call. This happens outside the transaction — the claim is already committed, and the SELECT is a read-only operation.

---

## The Modify Procedure — State Machine

The `Modify_` procedure is called by the worker after processing to report the result. It enforces state machine transitions and uses optimistic concurrency via `UpdatedAt`:

Key rules:
- **Optimistic concurrency**: The worker must provide the `UpdatedAt` it received from `Next_`. The UPDATE's WHERE clause includes `AND UpdatedAt = @UpdatedAt` — if another process modified the row, @@ROWCOUNT = 0 and the update is rejected.
- **State machine enforcement**: Use the classification functions to validate transitions. A finished item cannot be modified. A processing item cannot be set back to Pending.
- **Max attempt enforcement**: If `AttemptNum >= MaxAttempts` and the new status isn't Completed, force the status to Failed.
- **Duration calculation**: When transitioning to a finished state, compute `DATEDIFF(MILLISECOND, @StartedAt, SYSDATETIME())`.
- **Step tracking**: The worker can update `Step` to record progress through a multi-step job. On retry, the worker reads the current step and resumes from where it left off.
- **Partial completion**: If the worker reports Completed but sub-items (e.g., email channel, SMS channel) have errors, set status to PartiallyCompleted and aggregate the errors.

The procedure shape:

    CREATE OR ALTER PROCEDURE Modify_Notification_trx
        @EnqueuedAt _Timestamp,
        @UpdatedAt _Timestamp,        -- optimistic concurrency token
        @Status QueueState,
        @Step QueueStep = NULL,        -- current step in multi-step jobs
        @Response WebResponse = NULL,
        @Error WebResponse = NULL,
        @ScheduledFor _Timestamp = NULL
    AS BEGIN
        -- 1. Validate @@TRANCOUNT = 0
        -- 2. Classify the new and current status using QueueIs*_fn functions
        -- 3. Validate the transition is legal
        -- 4. Read max attempts from AppSettings (default to 3)
        -- 5. Enforce max attempts (force Failed if exceeded)
        -- 6. Calculate duration if finishing
        -- 7. UPDATE with WHERE UpdatedAt = @UpdatedAt (optimistic concurrency)
        --    Include Step = ISNULL(@Step, Step) to preserve or advance the step
        -- 8. Return updated item through worker view
    END;

---

## Queues as Base/Subtype

Relational queues naturally combine with the base/subtype pattern. The queue table is the base (shared lifecycle columns), and subtypes carry job-specific data:

    -- Base: shared queue columns
    CREATE TABLE Notification (
        EnqueuedAt _Timestamp PRIMARY KEY,
        [Type] _Type,
        [Status] QueueState,
        [Step] QueueStep,
        AttemptNum AttemptNum,
        Response WebResponse DEFAULT '',
        Error WebResponse DEFAULT '',
        StartedAt _Timestamp,
        Duration Duration,
        ScheduledFor _Timestamp,
        UpdatedAt _Timestamp,

        CONSTRAINT Notification_IsDiscriminatedBy_NotificationType
            FOREIGN KEY ([Type]) REFERENCES NotificationType([Type]),
        CONSTRAINT Notification_IsStatedBy_QueueStatus
            FOREIGN KEY ([Status]) REFERENCES QueueStatus([Status])
    );

    -- Exclusive subtype: data specific to a password reset notification
    CREATE TABLE Notification_ResetPassword (
        EnqueuedAt _Timestamp PRIMARY KEY,
        OTP OtpCode,
        UserID DbUserID,
        Username DbUsername,

        CONSTRAINT ResetPassword_Is_Notification
            FOREIGN KEY (EnqueuedAt) REFERENCES Notification(EnqueuedAt),
        CONSTRAINT ResetPassword_IsType_Notification
            CHECK (dbo.Notification_IsType_fn(EnqueuedAt, 'ResetPassword') = 1)
    );

    -- Inclusive subtypes: delivery channels (a notification can be both email AND sms)
    CREATE TABLE Notification_Email (
        EnqueuedAt _Timestamp PRIMARY KEY,
        EmailTo Email,
        PreferredLanguage [Name] DEFAULT 'en',
        Response WebResponse DEFAULT '',
        Error WebResponse DEFAULT '',

        CONSTRAINT Email_Is_Notification
            FOREIGN KEY (EnqueuedAt) REFERENCES Notification(EnqueuedAt)
    );

The `Next_` and `Modify_` procedures operate on the base table. The worker reads the subtype data it needs through views that join base and subtype.

---

## See Also

- [Base/Subtype Inheritance](basetype-subtype.md) — the base/subtype pattern used by queue content subtypes and channel subtypes
- [Procedure Structure](procedure-structure.md) — `_trx` / `_utx` templates used by the Next_ and Modify_ procedures
- [Application Settings](application-settings.md) — the AppSettings table where queue configuration (max attempts, backoff) is stored

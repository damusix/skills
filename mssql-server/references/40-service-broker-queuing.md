# 40 — Service Broker & Queuing

## Table of Contents
1. [When to Use](#when-to-use)
2. [Architecture Overview](#architecture-overview)
3. [Core Objects Reference](#core-objects-reference)
4. [Creating the Infrastructure](#creating-the-infrastructure)
5. [Sending Messages (Producer)](#sending-messages-producer)
6. [Receiving Messages (Consumer)](#receiving-messages-consumer)
7. [Internal Activation (Auto-scaling Workers)](#internal-activation-auto-scaling-workers)
8. [Complete Working Example](#complete-working-example)
9. [External Activation](#external-activation)
10. [Routing and Remote Services](#routing-and-remote-services)
11. [Pub/Sub Patterns](#pubsub-patterns)
12. [Conversation Group Locking](#conversation-group-locking)
13. [Poison Message Handling](#poison-message-handling)
14. [Table-as-Queue Pattern](#table-as-queue-pattern)
15. [Query Notifications (SqlDependency)](#query-notifications-sqldependency)
16. [SSB vs Table-as-Queue vs External Broker](#ssb-vs-table-as-queue-vs-external-broker)
17. [Monitoring with sys.dm_broker_*](#monitoring-with-sysdm_broker_)
18. [Maintenance and Cleanup](#maintenance-and-cleanup)
19. [Azure SQL Considerations](#azure-sql-considerations)
20. [Gotchas](#gotchas)
21. [See Also](#see-also)
22. [Sources](#sources)

---

## When to Use

Service Broker (SSB) is SQL Server's built-in transactional, durable messaging system. Use it when:

- You need **exactly-once, in-order delivery** within or across SQL Server instances
- You want **async work triggered by database events** (audit trail, denormalization, email after insert) without blocking the transaction
- You need **background processing** that survives server restarts without external infrastructure
- You want to **decouple** high-latency work (calling external APIs, report generation) from OLTP transactions
- You need guaranteed delivery of messages **across databases** on the same instance

Avoid SSB when:
- Messages need to flow to/from non-SQL endpoints (use Azure Service Bus, Kafka, RabbitMQ instead)
- Sub-second latency is required (SSB activation polling has ~200ms wake interval)
- You need at-least-once delivery with consumer-side deduplication semantics
- Your team lacks SSB operational expertise — it has a steep learning curve

---

## Architecture Overview

SSB is a store-and-forward messaging system built into the SQL Server engine. All messages are stored in the database's log and survive restarts.

```
Producer                          Consumer
────────                          ────────
BEGIN DIALOG CONVERSATION         RECEIVE (from queue)
  → message type validation         → process message
  → route lookup                    → END CONVERSATION
  → target service queue               ↑
SEND ON conversation_handle       Internal Activation
END CONVERSATION                    (stored proc started
                                     automatically when
                                     messages arrive)
```

**Key concepts:**

| Term | Definition |
|------|-----------|
| **Message Type** | Named message format; can enforce XML schema or allow any content |
| **Contract** | Defines which message types each side (INITIATOR/TARGET) may send |
| **Queue** | Durable message store (a system table); one per service |
| **Service** | Named endpoint bound to a queue and zero or more contracts |
| **Dialog Conversation** | Bidirectional, ordered, reliable channel between two services |
| **Conversation Group** | Logical grouping of related conversations; controls row locking in RECEIVE |
| **Route** | Maps service name to broker endpoint for remote delivery |
| **Endpoint** | TCP listener for cross-instance SSB traffic |
| **Activation** | Auto-starts a stored proc when messages arrive in a queue |

---

## Core Objects Reference

### Object creation order (dependencies flow downward)

```
1. Message Types
2. Contracts           (references message types)
3. Queues              (no dependencies)
4. Services            (references queues + contracts)
5. Routes              (for remote services only)
6. Endpoints           (for remote services only)
```

### Message Types

```sql
-- Allow any binary/text content
CREATE MESSAGE TYPE [//MyApp/Request]
    VALIDATION = NONE;

-- Must be well-formed XML
CREATE MESSAGE TYPE [//MyApp/Response]
    VALIDATION = WELL_FORMED_XML;

-- Must validate against a registered XML schema collection
CREATE MESSAGE TYPE [//MyApp/OrderEvent]
    VALIDATION = VALID_XML WITH SCHEMA COLLECTION [dbo].[OrderEventSchema];

-- Built-in end-of-conversation type (always exists)
-- [http://schemas.microsoft.com/SQL/ServiceBroker/EndDialog]
-- [http://schemas.microsoft.com/SQL/ServiceBroker/Error]
```

### Contracts

```sql
-- Only the initiator sends requests; only the target sends responses
CREATE CONTRACT [//MyApp/RequestResponse]
(
    [//MyApp/Request]   SENT BY INITIATOR,
    [//MyApp/Response]  SENT BY TARGET
);

-- Either side can send (fire-and-forget or bidirectional)
CREATE CONTRACT [//MyApp/EventContract]
(
    [//MyApp/OrderEvent] SENT BY ANY
);
```

### Queues

```sql
CREATE QUEUE [dbo].[RequestQueue]
    WITH
        STATUS = ON,
        RETENTION = OFF,               -- keep sent messages in queue; OFF is default/recommended
        POISON_MESSAGE_HANDLING (STATUS = ON);  -- auto-disable after 5 consecutive rollbacks

-- Queue with activation
CREATE QUEUE [dbo].[RequestQueue]
    WITH
        STATUS = ON,
        POISON_MESSAGE_HANDLING (STATUS = ON),
        ACTIVATION (
            STATUS = ON,
            PROCEDURE_NAME = [dbo].[usp_ProcessRequest],
            MAX_QUEUE_READERS = 5,
            EXECUTE AS OWNER
        );
```

### Services

```sql
-- Target service (receives requests)
CREATE SERVICE [//MyApp/TargetService]
    ON QUEUE [dbo].[RequestQueue]
    ([//MyApp/RequestResponse]);    -- must list all contracts this service accepts

-- Initiator service (sends requests, receives responses)
CREATE SERVICE [//MyApp/InitiatorService]
    ON QUEUE [dbo].[ResponseQueue]; -- initiator service needs its own queue for responses
```

---

## Creating the Infrastructure

```sql
-- Full setup script for a simple request/response queue
USE [MyDatabase];
GO

-- 1. Message types
CREATE MESSAGE TYPE [//MyApp/Request]   VALIDATION = WELL_FORMED_XML;
CREATE MESSAGE TYPE [//MyApp/Response]  VALIDATION = WELL_FORMED_XML;
GO

-- 2. Contract
CREATE CONTRACT [//MyApp/RequestResponse]
(
    [//MyApp/Request]   SENT BY INITIATOR,
    [//MyApp/Response]  SENT BY TARGET
);
GO

-- 3. Queues
CREATE QUEUE [dbo].[RequestQueue]
    WITH STATUS = ON, POISON_MESSAGE_HANDLING (STATUS = ON);

CREATE QUEUE [dbo].[ResponseQueue]
    WITH STATUS = ON, POISON_MESSAGE_HANDLING (STATUS = ON);
GO

-- 4. Services
CREATE SERVICE [//MyApp/TargetService]
    ON QUEUE [dbo].[RequestQueue]
    ([//MyApp/RequestResponse]);

CREATE SERVICE [//MyApp/InitiatorService]
    ON QUEUE [dbo].[ResponseQueue];
GO
```

---

## Sending Messages (Producer)

```sql
DECLARE @conversation_handle UNIQUEIDENTIFIER;
DECLARE @message_body        XML;

-- Every message must be sent within a BEGIN/END DIALOG CONVERSATION
BEGIN DIALOG CONVERSATION @conversation_handle
    FROM SERVICE [//MyApp/InitiatorService]
    TO   SERVICE '//MyApp/TargetService'   -- string, not identifier
    ON CONTRACT [//MyApp/RequestResponse]
    WITH ENCRYPTION = OFF;                  -- ON requires certificates + routes

-- Build the payload
SET @message_body = N'<Request><OrderId>42</OrderId></Request>';

-- Send (atomically with the surrounding user transaction)
;SEND ON CONVERSATION @conversation_handle
    MESSAGE TYPE [//MyApp/Request] (@message_body);

-- If fire-and-forget (no response expected), end the conversation immediately
-- END CONVERSATION @conversation_handle;

-- The SEND is part of your transaction — if the transaction rolls back,
-- the message is NOT delivered. This is the "transactional inbox" pattern.
```

**Key SEND behaviours:**
- SEND is part of the ambient transaction — rollback = no message sent
- `TO SERVICE` is a string literal, evaluated at runtime via route table
- Messages are serialized within a conversation handle (ordered delivery guaranteed)
- Multiple messages on the same handle are delivered in send order

---

## Receiving Messages (Consumer)

```sql
DECLARE @conversation_handle UNIQUEIDENTIFIER;
DECLARE @message_type        SYSNAME;
DECLARE @message_body        VARBINARY(MAX);

-- RECEIVE is a blocking statement; WAITFOR adds a timeout
WAITFOR (
    RECEIVE TOP(1)
        @conversation_handle = conversation_handle,
        @message_type        = message_type_name,
        @message_body        = message_body
    FROM [dbo].[RequestQueue]
), TIMEOUT 5000;    -- milliseconds; 0 = non-blocking

IF @conversation_handle IS NOT NULL
BEGIN
    IF @message_type = '//MyApp/Request'
    BEGIN
        -- Process the message
        DECLARE @xml XML = CAST(@message_body AS XML);
        DECLARE @order_id INT = @xml.value('(/Request/OrderId)[1]', 'INT');

        -- ... do work ...

        -- Send response
        ;SEND ON CONVERSATION @conversation_handle
            MESSAGE TYPE [//MyApp/Response]
            (CAST(N'<Response><Status>OK</Status></Response>' AS VARBINARY(MAX)));

        -- End conversation when done
        END CONVERSATION @conversation_handle;
    END
    ELSE IF @message_type = 'http://schemas.microsoft.com/SQL/ServiceBroker/EndDialog'
    BEGIN
        -- Initiator has ended its side; clean up
        END CONVERSATION @conversation_handle;
    END
    ELSE IF @message_type = 'http://schemas.microsoft.com/SQL/ServiceBroker/Error'
    BEGIN
        DECLARE @error_xml XML = CAST(@message_body AS XML);
        DECLARE @error_code INT     = @error_xml.value('(/Error/Code)[1]', 'INT');
        DECLARE @error_desc NVARCHAR(4000) = @error_xml.value('(/Error/Description)[1]', 'NVARCHAR(4000)');
        -- log error
        END CONVERSATION @conversation_handle;
    END
END
```

**RECEIVE batching (high-throughput pattern):**

```sql
DECLARE @messages TABLE
(
    conversation_handle  UNIQUEIDENTIFIER,
    message_type_name    SYSNAME,
    message_body         VARBINARY(MAX)
);

WAITFOR (
    RECEIVE TOP(100)         -- batch up to 100 messages
        conversation_handle,
        message_type_name,
        message_body
    FROM [dbo].[RequestQueue]
    INTO @messages
), TIMEOUT 1000;

-- Process all rows in @messages as a set
```

---

## Internal Activation (Auto-scaling Workers)

Internal activation automatically starts (and stops) stored procedure instances when messages arrive. SQL Server manages the lifecycle:

- Starts a new proc instance when the queue has unprocessed messages AND fewer than `MAX_QUEUE_READERS` are running
- The proc must drain messages from the queue itself (not handed a message)
- Proc exits normally → SQL Server starts another if messages remain
- No messages → proc exits → no instances running (zero idle cost)

### Activation procedure template

```sql
CREATE OR ALTER PROCEDURE [dbo].[usp_ProcessRequest]
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @conversation_handle UNIQUEIDENTIFIER;
    DECLARE @message_type        SYSNAME;
    DECLARE @message_body        VARBINARY(MAX);

    -- Keep looping until the queue is empty
    WHILE (1 = 1)
    BEGIN
        BEGIN TRANSACTION;

        BEGIN TRY
            WAITFOR (
                RECEIVE TOP(1)
                    @conversation_handle = conversation_handle,
                    @message_type        = message_type_name,
                    @message_body        = message_body
                FROM [dbo].[RequestQueue]
            ), TIMEOUT 1000;

            -- No message available — exit cleanly
            IF @conversation_handle IS NULL
            BEGIN
                ROLLBACK TRANSACTION;
                RETURN;
            END

            -- Dispatch by message type
            IF @message_type = '//MyApp/Request'
            BEGIN
                DECLARE @xml      XML  = CAST(@message_body AS XML);
                DECLARE @order_id INT  = @xml.value('(/Request/OrderId)[1]', 'INT');

                -- Business logic here
                INSERT INTO dbo.ProcessedOrders (OrderId, ProcessedAt)
                VALUES (@order_id, SYSDATETIME());

                ;SEND ON CONVERSATION @conversation_handle
                    MESSAGE TYPE [//MyApp/Response]
                    (CAST(N'<Response><Status>OK</Status></Response>' AS VARBINARY(MAX)));

                END CONVERSATION @conversation_handle;
            END
            ELSE IF @message_type IN (
                'http://schemas.microsoft.com/SQL/ServiceBroker/EndDialog',
                'http://schemas.microsoft.com/SQL/ServiceBroker/Error'
            )
            BEGIN
                END CONVERSATION @conversation_handle;
            END

            COMMIT TRANSACTION;
        END TRY
        BEGIN CATCH
            ROLLBACK TRANSACTION;
            -- Log error — do NOT re-raise; that kills the activation proc
            -- and SSB will re-activate on next message (creating retry logic)
            INSERT INTO dbo.BrokerErrors (ErrorTime, ErrorMessage, ErrorSeverity)
            VALUES (SYSDATETIME(), ERROR_MESSAGE(), ERROR_SEVERITY());
        END CATCH
    END
END;
GO

-- Attach activation to queue
ALTER QUEUE [dbo].[RequestQueue]
    WITH ACTIVATION (
        STATUS           = ON,
        PROCEDURE_NAME   = [dbo].[usp_ProcessRequest],
        MAX_QUEUE_READERS = 5,          -- max concurrent instances
        EXECUTE AS       OWNER          -- or SELF, or 'username'
    );
```

> [!NOTE] SQL Server 2022
> `EXECUTE AS` for activation now supports contained database users. In earlier versions only database users with server login could be specified for cross-database activation.

---

## Complete Working Example

End-to-end: producer sends async email notification, consumer processes it.

```sql
USE [MyDatabase];
GO

-- ============================================================
-- INFRASTRUCTURE
-- ============================================================
CREATE MESSAGE TYPE [//MyApp/EmailRequest]  VALIDATION = WELL_FORMED_XML;
CREATE CONTRACT    [//MyApp/EmailContract]  ([//MyApp/EmailRequest] SENT BY INITIATOR);
CREATE QUEUE       [dbo].[EmailQueue]       WITH STATUS = ON, POISON_MESSAGE_HANDLING (STATUS = ON);
CREATE SERVICE     [//MyApp/EmailSender]    ON QUEUE [dbo].[EmailQueue] ([//MyApp/EmailContract]);
CREATE SERVICE     [//MyApp/EmailClient]    ON QUEUE [dbo].[EmailQueue];  -- fire-and-forget; reuse same queue
GO

-- ============================================================
-- CONSUMER (activation procedure)
-- ============================================================
CREATE OR ALTER PROCEDURE [dbo].[usp_SendEmailFromQueue]
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @ch   UNIQUEIDENTIFIER;
    DECLARE @mt   SYSNAME;
    DECLARE @body VARBINARY(MAX);
    DECLARE @xml  XML;

    WHILE (1 = 1)
    BEGIN
        BEGIN TRANSACTION;
        BEGIN TRY
            WAITFOR (
                RECEIVE TOP(1)
                    @ch   = conversation_handle,
                    @mt   = message_type_name,
                    @body = message_body
                FROM [dbo].[EmailQueue]
            ), TIMEOUT 500;

            IF @ch IS NULL
            BEGIN
                ROLLBACK;
                RETURN;
            END

            IF @mt = '//MyApp/EmailRequest'
            BEGIN
                SET @xml = CAST(@body AS XML);

                EXEC msdb.dbo.sp_send_dbmail
                    @profile_name  = 'Default',
                    @recipients    = @xml.value('(/Email/To)[1]',      'NVARCHAR(500)'),
                    @subject       = @xml.value('(/Email/Subject)[1]', 'NVARCHAR(500)'),
                    @body          = @xml.value('(/Email/Body)[1]',     'NVARCHAR(MAX)'),
                    @body_format   = 'HTML';
            END

            IF @mt IN (
                'http://schemas.microsoft.com/SQL/ServiceBroker/EndDialog',
                'http://schemas.microsoft.com/SQL/ServiceBroker/Error'
            )
                END CONVERSATION @ch;

            COMMIT;
        END TRY
        BEGIN CATCH
            ROLLBACK;
        END CATCH
    END
END;
GO

ALTER QUEUE [dbo].[EmailQueue]
    WITH ACTIVATION (
        STATUS            = ON,
        PROCEDURE_NAME    = [dbo].[usp_SendEmailFromQueue],
        MAX_QUEUE_READERS = 3,
        EXECUTE AS        OWNER
    );
GO

-- ============================================================
-- PRODUCER — call this from any OLTP transaction
-- ============================================================
CREATE OR ALTER PROCEDURE [dbo].[usp_QueueEmail]
    @To      NVARCHAR(500),
    @Subject NVARCHAR(500),
    @Body    NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @ch  UNIQUEIDENTIFIER;
    DECLARE @msg XML;

    SET @msg = (
        SELECT
            @To      AS [To],
            @Subject AS [Subject],
            @Body    AS [Body]
        FOR XML PATH('Email'), TYPE
    );

    BEGIN DIALOG CONVERSATION @ch
        FROM SERVICE [//MyApp/EmailClient]
        TO   SERVICE '//MyApp/EmailSender'
        ON CONTRACT [//MyApp/EmailContract]
        WITH ENCRYPTION = OFF;

    ;SEND ON CONVERSATION @ch
        MESSAGE TYPE [//MyApp/EmailRequest]
        (CAST(@msg AS VARBINARY(MAX)));

    -- Fire-and-forget: end our side immediately
    END CONVERSATION @ch WITH CLEANUP;
END;
GO

-- Usage: called inside a user transaction; email is queued atomically
BEGIN TRANSACTION;
    INSERT INTO dbo.Orders (CustomerId, Total) VALUES (101, 500.00);
    EXEC dbo.usp_QueueEmail
        @To      = 'customer@example.com',
        @Subject = 'Order Confirmed',
        @Body    = '<h1>Your order has been placed.</h1>';
COMMIT;
-- If the INSERT fails and we ROLLBACK, the SEND is also rolled back.
-- Email will never be sent. This is exactly the desired behavior.
```

---

## External Activation

External activation fires when messages arrive in a queue but no internal activation proc is defined. A Windows service or .NET process listens for an `QUEUE_ACTIVATION` event and then reads from the queue.

```sql
-- Configure external activation via event notification
CREATE EVENT NOTIFICATION [EN_EmailQueueActivation]
    ON QUEUE [dbo].[EmailQueue]
    FOR QUEUE_ACTIVATION
    TO SERVICE '//MyApp/ExternalActivator', 'current database';
```

The external activator process (e.g., the SQL Server External Activator service or a custom .NET service) subscribes to this event and starts a worker thread when notified.

External activation is typically used when the consumer is a non-T-SQL process (e.g., calling an HTTP API, running Python ML inference). For SQL-only workloads, internal activation is simpler and preferred.

---

## Routing and Remote Services

By default, SSB routes to services in the same database. For cross-database or cross-instance delivery:

```sql
-- Remote route: messages for //RemoteApp/Service go to broker at remote server
CREATE ROUTE [RemoteServiceRoute]
    WITH
        SERVICE_NAME         = '//RemoteApp/TargetService',
        BROKER_INSTANCE      = '6E5C3D9A-...',   -- remote database's service_broker_guid
        ADDRESS              = 'TCP://remoteserver:4022';

-- Local route (explicit, within same instance)
CREATE ROUTE [LocalRoute]
    WITH
        SERVICE_NAME = '//MyApp/TargetService',
        ADDRESS      = 'LOCAL';

-- Default catch-all route (implicit; exists as AutoCreatedLocal)
-- Sends unrouted messages to the local broker
```

**Cross-instance prerequisites:**
1. Create SSB endpoints on both instances (`CREATE ENDPOINT ... FOR SERVICE_BROKER`)
2. Configure certificates or Windows auth for endpoint authentication
3. `ALTER DATABASE ... SET ENABLE_BROKER` on both databases
4. Ensure no firewall blocks TCP port 4022

```sql
-- SSB endpoint example
CREATE ENDPOINT [SSBEndpoint]
    STATE = STARTED
    AS TCP (LISTENER_PORT = 4022)
    FOR SERVICE_BROKER (AUTHENTICATION = WINDOWS);
```

> [!WARNING] Deprecated
> The SQL Server External Activator service (a separate Windows component) was deprecated after SQL Server 2014. Replace with custom .NET service or Azure Functions triggered by event notification.

---

## Pub/Sub Patterns

SSB does not have native pub/sub, but you can implement fan-out:

```sql
-- Fan-out: one sender, multiple queues
CREATE OR ALTER PROCEDURE [dbo].[usp_PublishOrderEvent]
    @event_xml XML
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @ch UNIQUEIDENTIFIER;
    DECLARE @payload VARBINARY(MAX) = CAST(@event_xml AS VARBINARY(MAX));

    -- Send to each subscriber service
    BEGIN DIALOG CONVERSATION @ch
        FROM SERVICE [//MyApp/Publisher]
        TO SERVICE '//MyApp/SubscriberA'
        ON CONTRACT [//MyApp/EventContract]
        WITH ENCRYPTION = OFF;
    ;SEND ON CONVERSATION @ch MESSAGE TYPE [//MyApp/OrderEvent] (@payload);
    END CONVERSATION @ch WITH CLEANUP;

    BEGIN DIALOG CONVERSATION @ch
        FROM SERVICE [//MyApp/Publisher]
        TO SERVICE '//MyApp/SubscriberB'
        ON CONTRACT [//MyApp/EventContract]
        WITH ENCRYPTION = OFF;
    ;SEND ON CONVERSATION @ch MESSAGE TYPE [//MyApp/OrderEvent] (@payload);
    END CONVERSATION @ch WITH CLEANUP;
END;
```

For dynamic subscriptions, maintain a subscriber registry table and loop over it in the publish procedure.

---

## Conversation Group Locking

Conversation groups serialize access to related conversations within RECEIVE. When a RECEIVE takes a message from group G, all other RECEIVE statements block on messages in group G until the transaction commits or rolls back.

This ensures that a processing session has exclusive access to a set of related messages — critical for stateful conversations (e.g., multi-step workflows where step N depends on step N-1).

```sql
-- Explicit conversation group: related conversations share a group
DECLARE @group_id UNIQUEIDENTIFIER = NEWID();

BEGIN DIALOG CONVERSATION @ch1
    FROM SERVICE [//MyApp/Workflow]
    TO SERVICE '//MyApp/Worker'
    ON CONTRACT [//MyApp/WorkflowContract]
    WITH RELATED_CONVERSATION_GROUP = @group_id,
         ENCRYPTION = OFF;

BEGIN DIALOG CONVERSATION @ch2
    FROM SERVICE [//MyApp/Workflow]
    TO SERVICE '//MyApp/Worker'
    ON CONTRACT [//MyApp/WorkflowContract]
    WITH RELATED_CONVERSATION_GROUP = @group_id,
         ENCRYPTION = OFF;
-- ch1 and ch2 are in the same group; RECEIVE on one locks the other
```

**Conversation group locking is a feature, not just a gotcha** — it's the mechanism that gives SSB its "serial within a group" ordering guarantee.

---

## Poison Message Handling

A "poison message" is one that causes a processing procedure to consistently fail and roll back. Without protection, it loops forever, blocking the queue.

With `POISON_MESSAGE_HANDLING (STATUS = ON)` (the default since SQL Server 2008), SSB disables the queue after 5 consecutive rollbacks of the same conversation group. The queue status changes to `NOTIFIED`.

```sql
-- Check for disabled queues
SELECT name, is_receive_enabled, is_enqueue_enabled, is_activation_enabled
FROM sys.service_queues
WHERE is_receive_enabled = 0;

-- Re-enable after fixing the root cause
ALTER QUEUE [dbo].[RequestQueue] WITH STATUS = ON;

-- Poison message safe-removal pattern
BEGIN TRANSACTION;
RECEIVE TOP(1) conversation_handle, message_type_name, message_body
FROM [dbo].[RequestQueue];
-- Inspect, log, or dead-letter the message
-- Do NOT process it; just consume and discard
COMMIT;
```

**Best practice:** Add a dead-letter queue. In the CATCH block, forward the unprocessable message to a dead-letter service instead of rolling back indefinitely.

```sql
-- In the catch block of the activation proc
BEGIN TRANSACTION;

;SEND ON CONVERSATION @ch
    -- Re-route to a dead-letter service for later analysis
    -- (requires a separate dead-letter service/queue setup)
    MESSAGE TYPE [//MyApp/DeadLetter]
    (@original_body);

END CONVERSATION @ch;
COMMIT;
```

---

## Table-as-Queue Pattern

For simpler use cases where SSB is overkill, a table with `OUTPUT` on `DELETE` provides a reliable queue pattern:

```sql
-- Queue table
CREATE TABLE dbo.JobQueue
(
    JobId       INT           NOT NULL IDENTITY(1,1) PRIMARY KEY,
    Payload     NVARCHAR(MAX) NOT NULL,
    QueuedAt    DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
    VisibleAfter DATETIME2    NOT NULL DEFAULT SYSDATETIME()
);

-- Producer
INSERT INTO dbo.JobQueue (Payload) VALUES ('{"type":"SendEmail","to":"x@y.com"}');

-- Consumer: dequeue one item atomically (no double-delivery)
DECLARE @job TABLE (JobId INT, Payload NVARCHAR(MAX));

DELETE TOP(1) FROM dbo.JobQueue
OUTPUT deleted.JobId, deleted.Payload INTO @job
WHERE VisibleAfter <= SYSDATETIME();

-- Process @job
```

**With visibility timeout (at-least-once delivery):**

```sql
CREATE TABLE dbo.JobQueue
(
    JobId        INT           NOT NULL IDENTITY(1,1) PRIMARY KEY,
    Payload      NVARCHAR(MAX) NOT NULL,
    LockedUntil  DATETIME2     NULL,          -- NULL = available
    LockedBy     UNIQUEIDENTIFIER NULL        -- worker ID
);

-- Dequeue with visibility timeout (claim for 5 minutes)
DECLARE @worker_id UNIQUEIDENTIFIER = NEWID();
DECLARE @job       TABLE (JobId INT, Payload NVARCHAR(MAX));

UPDATE TOP(1) dbo.JobQueue
SET
    LockedUntil = DATEADD(MINUTE, 5, SYSDATETIME()),
    LockedBy    = @worker_id
OUTPUT inserted.JobId, inserted.Payload INTO @job
WHERE LockedUntil IS NULL OR LockedUntil < SYSDATETIME();

-- After successful processing
DELETE FROM dbo.JobQueue WHERE JobId = (SELECT JobId FROM @job);
-- If processing fails, LockedUntil expires and another worker can claim it
```

> [!NOTE]
> The table-as-queue pattern is simpler but provides **at-least-once** (or exactly-once with DELETE approach), no guaranteed ordering without explicit ORDER BY, and no activation — a polling loop or external scheduler is required.

---

## Query Notifications (SqlDependency)

Query Notifications let a .NET application subscribe to data changes for a specific query. When the result set changes, the app is notified. Internally uses Service Broker.

```sql
-- SSB must be enabled for Query Notifications to work
ALTER DATABASE [MyDatabase] SET ENABLE_BROKER;

-- The query being monitored must qualify (SELECT only, schema-qualified,
-- no aggregates, no subqueries on base tables, no non-deterministic funcs)
-- Example qualifying query:
SELECT OrderId, Status FROM dbo.Orders WHERE CustomerId = 42;
```

```csharp
// .NET SqlDependency usage
using SqlDependency dep = new SqlDependency(cmd);
dep.OnChange += (sender, e) =>
{
    // Re-execute the query; e.Info has reason (Insert/Update/Delete/Invalid/etc.)
};
cmd.ExecuteReader();
```

**Query Notification limitations:**
- Fires at most once per subscription (must re-subscribe after each notification)
- Only notifies *that* something changed, not *what* changed
- Does not scale to thousands of concurrent subscriptions
- Not supported in Azure SQL Database[^11]
- Prefer CDC or Change Tracking for ETL; SqlDependency is mainly for cache invalidation

---

## SSB vs Table-as-Queue vs External Broker

| Feature | Service Broker | Table-as-Queue | Kafka / RabbitMQ / Azure SB |
|---------|---------------|----------------|------------------------------|
| **Delivery guarantee** | Exactly-once, in-order | Exactly-once (DELETE) or at-least-once (visibility timeout) | Depends on broker/consumer config |
| **Ordering** | Per-conversation (guaranteed) | Requires explicit ORDER BY | Partition-level (Kafka) or FIFO queues |
| **Transactional SEND** | Yes — same transaction as INSERT/UPDATE | Yes — same transaction | Varies; often no or two-phase-commit only |
| **Infrastructure** | None (built into SQL Server) | None (a table) | External service; ops burden |
| **Cross-instance routing** | Yes (TCP + certificates) | No (without distributed transactions) | Yes |
| **Consumer scaling** | Auto (activation, up to MAX_QUEUE_READERS) | Manual polling loop | Consumer groups (Kafka), competing consumers |
| **Activation / push** | Yes (internal activation) | No (must poll) | Yes (push callbacks/triggers) |
| **Poison message handling** | Built-in (disable after 5 rollbacks) | Must implement manually | Varies (DLQ options) |
| **Non-SQL consumers** | Via external activation (complex) | Any language via SQL connection | Native SDKs in all languages |
| **Operational complexity** | High (conversation lifecycle, routes) | Low | Medium to high (depends on broker) |
| **Best fit** | Async SQL-to-SQL workflows; guaranteed transactional delivery | Simple background jobs; small scale | High-throughput, polyglot, cross-service events |

**Decision rule:**
- SQL-to-SQL, same instance, need transactional guarantees → **Service Broker**
- Simple background jobs, small team, no external infra → **Table-as-Queue**
- Cross-service, non-SQL consumers, high throughput (>1k msg/sec) → **External broker**

---

## Monitoring with sys.dm_broker_*

```sql
-- Queue depth (backlog per queue)
SELECT
    q.name                                                   AS queue_name,
    COUNT(*)                                                 AS message_count,
    SUM(DATALENGTH(msg.message_body))                        AS total_bytes
FROM sys.service_queues q
LEFT JOIN sys.transmission_queue msg ON 1=0   -- placeholder; see below
GROUP BY q.name;

-- Actual message count per queue (using internal catalog)
SELECT
    q.name          AS queue_name,
    sq.message_count
FROM sys.service_queues q
CROSS APPLY (
    SELECT COUNT(*) AS message_count
    FROM sys.dm_broker_queue_monitors m
    WHERE m.queue_id = q.object_id
) sq;

-- Better: use sys.dm_broker_queue_monitors
SELECT
    database_id,
    queue_id,
    state,               -- INACTIVE, NOTIFIED, RECEIVES_OCCURRING
    last_empty_rowset_time,
    last_activated_time
FROM sys.dm_broker_queue_monitors;

-- Transmission queue: messages pending routing/delivery to remote services
SELECT
    to_service_name,
    to_broker_instance,
    message_type_name,
    transmission_status,   -- NULL = successful; error text if failed
    enqueue_time,
    message_id
FROM sys.transmission_queue
ORDER BY enqueue_time;

-- Active conversations
SELECT
    c.conversation_id,
    c.state_desc,        -- STARTED_OUTBOUND, CONVERSING, DISCONNECTED_INBOUND, etc.
    c.is_initiator,
    c.far_service,
    c.lifetime,
    c.security_timestamp
FROM sys.conversation_endpoints c;

-- Activation state
SELECT
    q.name,
    q.activation_procedure,
    q.max_readers,
    q.is_activation_enabled,
    q.is_receive_enabled,
    q.is_enqueue_enabled
FROM sys.service_queues q;

-- Broker configuration
SELECT
    name,
    is_broker_enabled,
    service_broker_guid
FROM sys.databases
WHERE name = DB_NAME();
```

**Monitoring alerts to set up:**
- `transmission_queue` rows with non-NULL `transmission_status` (delivery failures)
- Queue `is_receive_enabled = 0` (poison message disabled queue)
- `sys.dm_broker_queue_monitors.state = 'NOTIFIED'` for an extended period (activation not keeping up)

---

## Maintenance and Cleanup

```sql
-- Orphaned conversation endpoints (conversations never properly ended)
-- These accumulate over time if END CONVERSATION is missing
SELECT COUNT(*) AS orphaned
FROM sys.conversation_endpoints
WHERE state_desc NOT IN ('CONVERSING', 'STARTED_OUTBOUND')
AND   lifetime < DATEADD(DAY, -7, GETUTCDATE());

-- Force-close orphaned conversations (use with caution)
DECLARE @ch UNIQUEIDENTIFIER;
DECLARE cur CURSOR FAST_FORWARD FOR
    SELECT conversation_handle
    FROM sys.conversation_endpoints
    WHERE state_desc = 'DISCONNECTED_INBOUND'
    AND   lifetime < DATEADD(DAY, -1, GETUTCDATE());

OPEN cur;
FETCH NEXT FROM cur INTO @ch;
WHILE @@FETCH_STATUS = 0
BEGIN
    END CONVERSATION @ch WITH CLEANUP;
    FETCH NEXT FROM cur INTO @ch;
END
CLOSE cur;
DEALLOCATE cur;

-- Check for accumulated sys_transmission_queue entries
SELECT COUNT(*) FROM sys.transmission_queue;

-- Disable SSB for migration/maintenance
ALTER DATABASE [MyDatabase] SET DISABLE_BROKER;
-- Re-enable (assigns a new service_broker_guid — breaks existing remote routes)
ALTER DATABASE [MyDatabase] SET ENABLE_BROKER;
-- Re-enable with NEW_BROKER (new guid) or ERROR_BROKER_CONVERSATIONS (errors existing)
ALTER DATABASE [MyDatabase] SET NEW_BROKER;
```

> [!WARNING]
> `ALTER DATABASE SET NEW_BROKER` or `SET ENABLE_BROKER` assigns a new `service_broker_guid`. All existing remote routes and conversation endpoints become invalid. Use `NEW_BROKER` only after database restore/copy to prevent conversation handle conflicts between prod and restored copy.

---

## Azure SQL Considerations

| Feature | Azure SQL Database | Azure SQL Managed Instance |
|---------|-------------------|---------------------------|
| Service Broker | Supported (intra-database only) | Supported (full feature set) |
| Cross-instance routing | Not supported | Supported |
| SSB endpoints | Not supported | Supported |
| `ENABLE_BROKER` | Auto-enabled on new databases | Full support |
| `NEW_BROKER` | Supported | Supported |
| External activation | Not supported | Not supported |
| Query Notifications | Not supported[^11] | Supported |

**Azure SQL Database restriction:** SSB messages can only flow between services in the same database. For cross-database async messaging on Azure SQL Database, use Azure Service Bus or Azure Storage Queues.

---

## Gotchas

1. **Forgetting `END CONVERSATION`** — conversations accumulate in `sys.conversation_endpoints` indefinitely, growing the database. Always end both sides; the target ends in response to the initiator's END CONVERSATION.

2. **Fire-and-forget requires `END CONVERSATION WITH CLEANUP`** — if the initiator never receives a response, use `END CONVERSATION @ch WITH CLEANUP` (no final acknowledgment sent to target). Without this, the initiator-side endpoint remains open waiting for a response that will never come.

3. **`ALTER DATABASE SET ENABLE_BROKER` can deadlock** — it waits for all active connections to the database. Run during low-traffic windows or use `WITH ROLLBACK IMMEDIATE`.

4. **Activation proc must loop and drain** — if the proc processes one message and exits, SSB re-activates it for the next. This works but is inefficient. The WHILE(1=1) loop pattern is more efficient.

5. **`TO SERVICE` is a runtime string** — typos in the service name fail silently (message goes to transmission queue with an error status), not at compile time. Test with `SELECT * FROM sys.transmission_queue` after SEND.

6. **Message body is `VARBINARY(MAX)`** — must CAST to XML or NVARCHAR when reading. Do not assume it's natively typed.

7. **`SET ENCRYPTION = OFF` for same-instance**  — encrypting same-instance conversations requires certificate setup. Use `ENCRYPTION = OFF` unless you actually need cross-network encryption.

8. **Activation EXECUTE AS must resolve** — the database user specified in `EXECUTE AS` must exist. If the user is dropped and re-created, the activation proc link may break silently.

9. **Conversation group locking can cause deadlocks** — if two RECEIVE sessions each hold a conversation group lock and try to acquire each other's, you get an SSB deadlock. Design consumer loops to process one group at a time.

10. **`NEW_BROKER` breaks restores to the same instance** — when restoring a database copy alongside the original, always use `WITH NEW_BROKER` to get a new guid. Sharing a guid causes both databases to compete for conversation routing.

11. **Queue depth does not appear in `sys.dm_db_index_operational_stats`** — SSB queues are system tables, not user tables. Use `sys.dm_broker_queue_monitors` or `sys.transmission_queue` for monitoring.

12. **Poison message auto-disable fires on ANY error** — including infrastructure errors (disk full, log full). If the queue goes to `NOTIFIED` state, diagnose the root cause before re-enabling.

---

## See Also

- [`06-stored-procedures.md`](06-stored-procedures.md) — activation procedure patterns and EXECUTE AS
- [`13-transactions-locking.md`](13-transactions-locking.md) — transactional SEND semantics, RECEIVE row locking
- [`14-error-handling.md`](14-error-handling.md) — TRY/CATCH inside activation procedures
- [`48-database-mail.md`](48-database-mail.md) — `sp_send_dbmail` used in activation proc examples
- [`33-extended-events.md`](33-extended-events.md) — capturing SSB errors and conversation events
- [`37-change-tracking-cdc.md`](37-change-tracking-cdc.md) — alternative async change propagation

---

## Sources

[^1]: [SQL Server Service Broker](https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/sql-server-service-broker) — overview of Service Broker architecture, messaging concepts, and Azure SQL Managed Instance support
[^2]: [CREATE MESSAGE TYPE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-message-type-transact-sql) — syntax and options for defining named message formats with optional XML validation
[^3]: [CREATE CONTRACT (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-contract-transact-sql) — syntax for specifying which message types each side of a conversation may send
[^4]: [CREATE QUEUE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-queue-transact-sql) — syntax and options for creating Service Broker queues, including activation and poison message handling settings
[^5]: [CREATE SERVICE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-service-transact-sql) — syntax for defining a named Service Broker endpoint bound to a queue and contracts
[^6]: [BEGIN DIALOG CONVERSATION (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/begin-dialog-conversation-transact-sql) — syntax for initiating a reliable, ordered dialog between two services
[^7]: [SEND (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/send-transact-sql) — syntax for sending messages on one or more Service Broker conversations
[^8]: [RECEIVE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/receive-transact-sql) — syntax for retrieving messages from a queue, including WAITFOR and batch receive patterns
[^9]: [sys.dm_broker_queue_monitors (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-broker-queue-monitors-transact-sql) — DMV returning queue monitor state, last activation time, and tasks waiting per queue
[^10]: [sys.transmission_queue (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-transmission-queue-transact-sql) — catalog view listing messages pending routing or delivery to remote services, including transmission_status errors
[^11]: [Query Notifications in SQL Server - ADO.NET](https://learn.microsoft.com/en-us/dotnet/framework/data/adonet/sql/query-notifications-in-sql-server) — overview of SqlDependency and SqlNotificationRequest for cache-invalidation notifications built on Service Broker infrastructure
[^12]: [Writing Service Broker Procedures](https://rusanu.com/2006/10/16/writing-service-broker-procedures/) — Remus Rusanu's reference covering every technique for writing Service Broker activated procedures, with performance comparisons

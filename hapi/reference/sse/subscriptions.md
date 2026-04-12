## `@hapi/sse` Subscriptions Reference


Subscriptions declare named SSE channels. Clients connect via `GET <path>` and receive a long-lived event stream. The server publishes to matching subscribers.

    server.sse.subscription('/chat/{room}');

    await server.sse.publish('/chat/general', { text: 'hello' }, { event: 'message' });


### `server.sse.subscription(path, config?)`


Registers a subscription route. Clients connect via `GET <path>`.

    server.sse.subscription('/orders/{id}', {
        auth: { mode: 'required' },
        maxSessions: 500,
        maxDuration: 300_000,
        onSubscribe: async (session, path, params) => {

            const order = await getOrder(params.id);
            if (!order) {
                throw Boom.notFound('Order not found');
            }
        },
        onUnsubscribe: (session, path, params) => {

            trackDisconnect(params.id);
        },
        filter: (path, message, opts) => {

            return opts.credentials.id === message.ownerId;
        }
    });

| Option          | Type                                                                 | Description                                                                                          |
|-----------------|----------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `auth`          | `RouteOptions['auth']`                                               | hapi auth config for the route.                                                                      |
| `retry`         | `number \| null`                                                     | Override plugin-level retry interval.                                                                |
| `keepAlive`     | `{ interval: number } \| false`                                      | Override plugin-level keep-alive.                                                                    |
| `filter`        | `(path, message, opts) => boolean \| { override } \| Promise<...>`  | Per-session delivery filter. Return `false` to skip, or `{ override: newData }` to transform the event. |
| `onSubscribe`   | `(session, path, params) => void \| Promise<void>`                   | Fires before SSE headers are sent. Throw a Boom error to return that HTTP error to the client.       |
| `onUnsubscribe` | `(session, path, params) => void`                                    | Fires on client disconnect.                                                                          |
| `onReconnect`   | `(session, path, params) => void \| Promise<void>`                   | Fires when `Last-Event-ID` is present (after replay). Errors close the session gracefully.           |
| `replay`        | `Replayer`                                                           | Replay provider for reconnection replay. See [replay](replay.md).                                    |
| `maxSessions`   | `number`                                                             | Max concurrent sessions for this subscription. Excess connections receive a 503.                     |
| `maxDuration`   | `number`                                                             | Max connection lifetime in ms (±10% jitter). Sends a comment before closing.                        |


### `server.sse.publish(path, data, opts?)`


Publishes an event to all sessions matching the path. Returns the number of sessions that received the event.

    const delivered = await server.sse.publish('/chat/general', { text: 'hello' }, {
        event: 'message',
        id: 'msg-001',
        internal: { source: 'bot' },
        matchMode: 'pattern'
    });

| Option       | Type                     | Description                                                                                                      |
|--------------|--------------------------|------------------------------------------------------------------------------------------------------------------|
| `event`      | `string`                 | SSE event name (the `event:` field clients listen for).                                                          |
| `id`         | `string`                 | SSE event ID. Only events with an explicit `id` are recorded by replay providers.                                |
| `internal`   | `object`                 | Arbitrary data passed to the `filter` function but not sent to the client.                                       |
| `matchMode`  | `'pattern' \| 'literal'` | `'pattern'` (default) matches subscription path patterns; `'literal'` matches only exact connected paths.        |


### `server.sse.broadcast(data, opts?)`


Sends an event to every connected session across all subscriptions.

    await server.sse.broadcast({ type: 'maintenance', message: 'Restarting in 5 min' });


### `server.sse.eachSession(fn, opts?)`


Iterates over connected sessions. Optionally filter by subscription pattern.

    await server.sse.eachSession((session) => {

        session.push({ type: 'ping' });
    }, { subscription: '/chat/{room}' });


### `server.sse.subscriptions()`


Returns a snapshot of all registered subscriptions:

    const subs = server.sse.subscriptions();
    // [{ pattern: '/chat/{room}', activeSessions: 12 }, ...]


### `server.sse.closeSessions(pattern)`


Closes all active sessions for a subscription pattern.

    await server.sse.closeSessions('/chat/{room}');


### Filter Functions


Filters run per `publish()` call, once per subscriber. Return `false` to skip delivery, `true` to deliver, or `{ override: newData }` to deliver a transformed payload.

    server.sse.subscription('/notifications/{userId}', {
        filter: (path, message, opts) => {

            // opts.credentials — subscriber's auth credentials
            // opts.internal — data from publish opts.internal (never sent to client)
            if (opts.credentials.id !== message.targetId) {
                return false;
            }

            // Strip admin fields for non-admin users
            if (!opts.credentials.isAdmin) {
                return { override: { text: message.text } };
            }

            return true;
        }
    });

    await server.sse.publish('/notifications/all', { text: 'Hi', targetId: '42', adminNote: 'secret' }, {
        internal: { source: 'system' }
    });


### Backpressure


Protects against slow consumers. Measured via Node's `writableLength`.

    server.sse.subscription('/stream', {
        backpressure: {
            maxBytes: 65536,   // trigger threshold
            strategy: 'drop'   // 'drop' | 'close'
        }
    });

| Strategy  | Behavior                                                |
|-----------|---------------------------------------------------------|
| `'close'` | Closes the session when pending bytes exceed `maxBytes`.|
| `'drop'`  | Silently drops the event but keeps the session open.    |

When backpressure triggers, `session.push()` returns `false`.


### Generics


Both `subscription` and `publish` accept a type parameter for type-safe payloads:

    interface ChatMessage {
        text: string;
        user: string;
    }

    server.sse.subscription<ChatMessage>('/chat/{room}', {
        filter: (path, message) => {

            // message is typed as ChatMessage
            return message.user !== 'blocked';
        }
    });

    await server.sse.publish<ChatMessage>('/chat/general', { text: 'hello', user: 'alice' });


### Gotchas


- **`onSubscribe` throwing rejects the connection.** The client receives that HTTP error code. Use Boom errors for proper status codes.
- **`onUnsubscribe` fires on disconnect.** It always fires when the connection ends, whether the client explicitly closed it or not.
- **`internal` data is never sent to clients.** Use it to pass server-side context to `filter` without leaking data.
- **`matchMode: 'literal'`** publishes only to sessions connected to that exact path string — no pattern expansion.
- **`maxSessions` returns 503.** Once the limit is reached, new connections get `503 Service Unavailable` until a slot opens.
- **`maxDuration` has jitter.** The ±10% jitter prevents thundering-herd reconnections when many sessions share the same TTL.
- **Filter returning `{ override }` sends the overridden data.** The original publish payload is not delivered to that subscriber.

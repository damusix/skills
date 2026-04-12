## `@hapi/sse` Overview


`@hapi/sse` is the official Server-Sent Events plugin for hapi. It provides WHATWG spec-compliant SSE with subscription-based pub/sub, event replay, backpressure, built-in stats, and lifecycle hooks.

    import Hapi from '@hapi/hapi';
    import { SsePlugin } from '@hapi/sse';

    const server = Hapi.server({ port: 3000 });

    await server.register({ plugin: SsePlugin });

    server.sse.subscription('/chat/{room}');

    await server.start();

    // Publish from anywhere
    await server.sse.publish('/chat/general', { text: 'hello', user: 'alice' }, { event: 'message' });


### Registration


Register as a standard hapi plugin. All options are optional — defaults work out of the box.

    await server.register({
        plugin: SsePlugin,
        options: {
            retry: 2000,
            keepAlive: { interval: 15_000 },
            headers: { 'X-Custom': 'value' },
            backpressure: { maxBytes: 65536, strategy: 'drop' },
            hooks: {
                onSession: (session, path, params) => console.log('connected', path),
                onSessionClose: (session, path, params) => console.log('closed', path),
                onPublish: (path, data, count) => console.log('delivered', count)
            }
        }
    });

| Option        | Type / Default                                             | Description                                    |
|---------------|------------------------------------------------------------|------------------------------------------------|
| `retry`       | `number \| null` / `2000`                                  | Client reconnect interval in ms. `null` to disable. Clamped to minimum 1000ms. |
| `keepAlive`   | `{ interval: number } \| false` / `{ interval: 15_000 }`  | Keep-alive comment interval. `false` to disable. |
| `headers`     | `Record<string, string>`                                   | Extra headers on every SSE response.           |
| `backpressure`| `BackpressureOptions`                                      | Optional backpressure config (see [subscriptions](subscriptions.md)). |
| `hooks`       | `SseHooks`                                                 | Optional lifecycle hooks (see below).          |


### Plugin API (`server.sse`)


After registration, `server.sse` exposes the full SSE API:

| Member                              | Description                                                               |
|-------------------------------------|---------------------------------------------------------------------------|
| `server.sse.subscription(path, config?)` | Register a subscription route. See [subscriptions](subscriptions.md). |
| `server.sse.publish(path, data, opts?)` | Publish to matching subscribers. Returns delivery count.             |
| `server.sse.broadcast(data, opts?)` | Send to every connected session. Returns delivery count.                  |
| `server.sse.eachSession(fn, opts?)` | Iterate sessions, optionally filtered by subscription pattern.            |
| `server.sse.subscriptions()`        | Snapshot of registered subscriptions with active session counts.          |
| `server.sse.closeSessions(pattern)` | Close all sessions for a subscription pattern.                            |
| `server.sse.sessionCount`           | Total active sessions across all subscriptions.                           |
| `server.sse.stats()`                | Built-in delivery metrics (see below).                                    |


### Stats


    const stats = server.sse.stats();
    // {
    //   totalConnections: 142,
    //   totalDisconnections: 138,
    //   totalPublishes: 9201,
    //   totalBroadcasts: 3,
    //   totalEventsDelivered: 45032,
    //   activeSessions: 4
    // }

| Stat                   | Description                                                         |
|------------------------|---------------------------------------------------------------------|
| `totalConnections`     | Cumulative connections since server start.                          |
| `totalDisconnections`  | Cumulative disconnections since server start.                       |
| `totalPublishes`       | Number of `publish()` calls.                                        |
| `totalBroadcasts`      | Number of `broadcast()` calls.                                      |
| `totalEventsDelivered` | Sum of all individual event deliveries.                             |
| `activeSessions`       | Current connected session count (same as `sessionCount`).           |


### Hooks


Lifecycle hooks for side effects. Errors are swallowed — hooks never break the stream.

| Hook             | Signature                                     | Description                       |
|------------------|-----------------------------------------------|-----------------------------------|
| `onSession`      | `(session, path, params) => void`             | Fires when a session connects.    |
| `onSessionClose` | `(session, path, params) => void`             | Fires when a session disconnects. |
| `onPublish`      | `(path, data, deliveryCount) => void`         | Fires after each `publish()`.     |


### Comparison with `@hapi/nes`


| | `@hapi/nes` (WebSocket) | `@hapi/sse` (SSE) |
|---|---|---|
| Transport | WebSocket (full-duplex) | HTTP SSE (server-to-client only) |
| Browser reconnect | Manual via client library | Native browser `EventSource` |
| Client library required | Yes (`@hapi/nes` client) | No (native `EventSource`) |
| Two-way messaging | Yes (`client.request()`, `client.message()`) | No |
| Route access over connection | Yes | No |
| Replay on reconnect | No built-in | Yes (via `FiniteReplayer` / `ValidReplayer`) |

Use `@hapi/sse` for unidirectional push (live feeds, notifications, streaming AI responses). Use `@hapi/nes` when clients need to send requests or messages back over the same connection.


### Security


| Defense                     | Description                                                                                    |
|-----------------------------|------------------------------------------------------------------------------------------------|
| Retry floor                 | `retry` clamped to minimum 1000ms to prevent reconnection storms. `null` disables entirely.    |
| `Last-Event-ID` sanitization| Control characters (`\x00`–`\x1f`) stripped to prevent null-byte injection and CRLF attacks.   |
| Connection limiting         | `maxSessions` caps concurrent connections per subscription. Excess gets a 503.                 |
| Connection TTL              | `maxDuration` with ±10% jitter prevents thundering herd reconnections.                         |
| CRLF injection protection   | `EventBuffer` strips/splits newlines in `event`/`id` fields and splits `data` on line terminators. |
| Backpressure                | `drop` or `close` strategies prevent unbounded memory growth.                                  |
| Not in scope                | Origin validation, CSRF, and authentication are handled by hapi's auth system and middleware.  |


### Exports


**Classes:** `EventBuffer`, `Session`, `SsePlugin`, `FiniteReplayer`, `ValidReplayer`

**Types:** `SsePluginOptions`, `SseApi`, `SseHandlerOptions`, `SseHooks`, `SseStats`, `SubscriptionConfig`, `SubscriptionInfo`, `FilterOptions`, `BackpressureOptions`, `Replayer`, `ReplayEntry`


### Gotchas


- **`retry` has a floor of 1000ms.** Values below 1000 are clamped to prevent reconnection storms. Use `null` to disable entirely.
- **SSE is HTTP, not WebSocket.** Each SSE connection is a long-lived HTTP response. Auth, CORS, and headers apply normally via hapi's route system.
- **Origin validation is out of scope.** Handle CORS with hapi's built-in CORS config or a middleware plugin.
- **`Last-Event-ID` is sanitized.** Control characters are stripped on receipt to prevent injection attacks.
- **Hooks never throw.** All hook errors are suppressed. Do not use hooks for critical business logic.

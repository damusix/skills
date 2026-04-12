## `@hapi/sse` Session Reference


A `Session` object represents a single active SSE connection. Sessions are passed to `onSubscribe`, `onUnsubscribe`, `onReconnect`, filter functions, hooks, and the custom handler `stream` function.


### Properties


| Member        | Type      | Description                                                               |
|---------------|-----------|---------------------------------------------------------------------------|
| `isOpen`      | `boolean` | `true` if the connection is still active.                                 |
| `connectedAt` | `number`  | Unix timestamp (ms) when the session was created.                         |
| `lastEventId` | `string`  | Value of the `Last-Event-ID` header. Empty string if absent.              |
| `request`     | `Request` | The original hapi `Request` object for the SSE connection.                |


### Methods


**`session.push(data, event?, id?)`** — Send an event to the client.

    session.push({ count: 42 });
    session.push({ count: 42 }, 'update');
    session.push({ count: 42 }, 'update', 'evt-001');

Returns `boolean` — `false` if the session is closed or the event was dropped by backpressure.

**`session.comment(text?)`** — Send a comment (invisible to `EventSource`, used for keep-alive).

    session.comment('keep-alive');

**`session.close()`** — End the connection gracefully.

    session.close();


### Metadata (`set` / `get` / `has` / `delete`)


Attach arbitrary metadata to a session. Useful for tracking state across `onSubscribe` / `filter` / `onUnsubscribe`.

    // In onSubscribe
    onSubscribe: async (session, path, params) => {

        const user = await getUser(session.request.auth.credentials.id);
        session.set('user', user);
    }

    // In eachSession
    await server.sse.eachSession((session) => {

        const user = session.get('user');
        if (user.role === 'admin') {
            session.push({ alert: 'admin-only notice' });
        }
    });

    // In onUnsubscribe
    onUnsubscribe: (session, path, params) => {

        if (session.has('user')) {
            trackDisconnect(session.get('user').id);
            session.delete('user');
        }
    }

| Method              | Returns   | Description                               |
|---------------------|-----------|-------------------------------------------|
| `set(key, value)`   | `void`    | Attach metadata to the session.           |
| `get(key)`          | `unknown` | Retrieve metadata by key.                 |
| `has(key)`          | `boolean` | Check if a key exists.                    |
| `delete(key)`       | `boolean` | Remove a key. Returns `true` if existed.  |


### Custom Handler Mode


For full imperative control over the event stream (e.g. streaming AI responses, file tailing), use the `sse` handler decorator:

    server.route({
        method: 'GET',
        path: '/ai/stream',
        handler: {
            sse: {
                stream: async (request, session) => {

                    for await (const token of streamAI(request.query.prompt)) {
                        if (!session.isOpen) {
                            break;
                        }

                        session.push({ token }, 'token');
                    }

                    session.push({ done: true }, 'done');
                },
                retry: 3000,
                keepAlive: { interval: 10_000 },
                headers: { 'X-Chat-Bot': 'true' },
                backpressure: { maxBytes: 32768, strategy: 'close' },
                maxDuration: 120_000
            }
        }
    });

| Option         | Type                                          | Description                                                                       |
|----------------|-----------------------------------------------|-----------------------------------------------------------------------------------|
| `stream`       | `(request, session) => void \| Promise<void>` | Required. Called after SSE headers are sent. Errors close the session gracefully. |
| `retry`        | `number \| null`                              | Override plugin-level retry.                                                      |
| `keepAlive`    | `{ interval: number } \| false`               | Override plugin-level keep-alive.                                                 |
| `headers`      | `Record<string, string>`                      | Override plugin-level headers.                                                    |
| `backpressure` | `BackpressureOptions`                         | Override plugin-level backpressure.                                               |
| `maxDuration`  | `number`                                      | Max connection lifetime in ms (±10% jitter).                                      |

The `stream` function is called after SSE headers are flushed. The session is open when it starts. Throwing inside `stream` closes the session gracefully (client will reconnect per the `retry` interval).


### Gotchas


- **Always check `session.isOpen` before pushing in loops.** The client may disconnect mid-stream.
- **`session.push()` returning `false` means the event was not delivered.** Either the session closed or backpressure dropped it.
- **`session.request` is the original hapi request.** Auth credentials, query params, and headers are available there.
- **`lastEventId` is sanitized.** Control characters are stripped before this property is set.
- **`session.comment()` is for keep-alive, not data.** `EventSource` ignores comment lines — they are invisible to event listeners.

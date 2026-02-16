## @hapi/nes Client Reference


The nes client (`Nes.Client`) provides the browser and Node.js interface for connecting to a hapi server with the nes plugin. It handles WebSocket connection management, authentication, request/response mapping, subscriptions, and automatic reconnection.

    const Nes = require('@hapi/nes');

    const client = new Nes.Client('ws://localhost:3000');
    await client.connect();

    const response = await client.request('/api/users');
    console.log(response.payload);  // [{ id: 1, name: 'John' }]


### Constructor


**`new Nes.Client(url, [options])`** -- creates a new nes client instance. (lib/client.js)

    const client = new Nes.Client('ws://localhost:3000', {
        timeout: 30000,
        ws: { rejectUnauthorized: false }  // Node.js only
    });

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | -- | **Required.** The WebSocket URL to connect to (e.g., `'ws://localhost:3000'` or `'wss://example.com'`). |
| `timeout` | `number \| false` | `false` | Default timeout in milliseconds for requests. `false` disables timeout. |
| `ws` | `object` | -- | Options passed directly to the underlying WebSocket constructor. In Node.js, this is passed to the `ws` library (e.g., TLS options). |


### client.connect([options])


Establishes the WebSocket connection. Must be called before making requests or subscribing. (lib/client.js)

    await client.connect({
        auth: { headers: { authorization: 'Bearer eyJhbG...' } },
        reconnect: true,
        delay: 1000,
        maxDelay: 5000,
        timeout: 10000
    });

| Option | Type | Default | Description |
|---|---|---|---|
| `auth` | `object \| string` | -- | Authentication credentials. If a string, sent as a token. If an object, can contain `headers` for header-based auth. |
| `auth.headers` | `object` | -- | Headers to include in the auth handshake (e.g., `{ authorization: 'Bearer ...' }`). |
| `reconnect` | `boolean` | `true` | Whether to automatically reconnect on disconnection. |
| `delay` | `number` | `1000` | Initial reconnection delay in milliseconds. |
| `maxDelay` | `number` | `5000` | Maximum reconnection delay in milliseconds (additive backoff caps here). |
| `retries` | `number` | `Infinity` | Maximum number of reconnection attempts. |
| `timeout` | `number` | -- | Connection timeout in milliseconds. |

**Authentication examples:**

    // Token auth (sent via nes auth endpoint)
    await client.connect({ auth: 'my-secret-token' });

    // Header auth (e.g., Bearer token)
    await client.connect({
        auth: { headers: { authorization: 'Bearer eyJhbG...' } }
    });

    // No auth
    await client.connect();


### client.disconnect()


Closes the WebSocket connection. Disables automatic reconnection. (lib/client.js)

    await client.disconnect();

After disconnecting, the client can be reconnected by calling `client.connect()` again.


### client.request(options)


Makes a request to a hapi route over the WebSocket connection. The request goes through the full hapi lifecycle on the server. (lib/client.js)

    // Simple GET
    const response = await client.request('/api/users');

    // Full options
    const response = await client.request({
        method: 'POST',
        path: '/api/items',
        payload: { name: 'Widget', price: 9.99 },
        headers: { 'x-request-id': 'abc123' }
    });

    console.log(response.statusCode);  // 200
    console.log(response.payload);     // { id: 1, name: 'Widget', price: 9.99 }

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | -- | **Required.** The route path (e.g., `'/api/users/42'`). |
| `method` | `string` | `'GET'` | HTTP method. |
| `payload` | `any` | -- | Request payload. Must be JSON-serializable. |
| `headers` | `object` | -- | Additional request headers. |

If a string is passed instead of an object, it is used as the `path` with `GET` method.

**Response object:**

| Property | Type | Description |
|---|---|---|
| `payload` | `any` | The response body from the hapi handler. |
| `statusCode` | `number` | HTTP status code. |
| `headers` | `object` | Response headers. |

**Error handling:**

When the server returns an error (4xx/5xx), the promise rejects with an `Error` that has `statusCode`, `data`, `message`, and `headers` properties:

    try {
        await client.request('/api/missing');
    }
    catch (err) {
        console.log(err.statusCode);  // 404
        console.log(err.message);     // 'Not Found'
    }


### client.subscribe(path, handler)


Subscribes to a server subscription channel. (lib/client.js)

    const handler = (update, flags) => {

        // update: the published message
        // flags.revoked: true if the subscription was revoked by the server
        console.log(update);
    };

    await client.subscribe('/items/42', handler);

| Parameter | Type | Description |
|---|---|---|
| `path` | `string` | The subscription path (e.g., `'/items/42'`). Must match a `server.subscription()` declaration. |
| `handler` | `function` | Called when a message is published. Signature: `function (update, flags)`. |

The `flags` object:

| Property | Type | Description |
|---|---|---|
| `revoked` | `boolean` | `true` when the subscription has been revoked by the server. `update` will be `null`. |


### client.unsubscribe(path, [handler])


Unsubscribes from a subscription channel. (lib/client.js)

    await client.unsubscribe('/items/42', handler);

    // Unsubscribe all handlers for a path
    await client.unsubscribe('/items/42');

| Parameter | Type | Description |
|---|---|---|
| `path` | `string` | The subscription path. |
| `handler` | `function` | Optional. The specific handler to remove. If omitted, all handlers for the path are removed. |


### client.message(message)


Sends a custom message to the server. The server must have an `onMessage` handler configured in the nes plugin options. (lib/client.js)

    const response = await client.message({ type: 'ping', data: 'hello' });
    console.log(response);  // whatever the server's onMessage handler returns

| Parameter | Type | Description |
|---|---|---|
| `message` | `any` | The message to send. Must be JSON-serializable. |


### server.onMessage Handler


Configured in nes plugin options. Handles custom messages sent by `client.message()`. (lib/index.js)

    await server.register({
        plugin: Nes,
        options: {
            onMessage: async (socket, message) => {

                // socket: the nes Socket object
                // message: the client's message payload

                if (message.type === 'ping') {
                    return { type: 'pong' };
                }

                return { type: 'unknown' };
            }
        }
    });

The return value of `onMessage` is sent back to the client as the response to `client.message()`.


### client.id


A unique identifier assigned to the client by the server upon connection. Available after `client.connect()` resolves. (lib/client.js)

    await client.connect();
    console.log(client.id);  // e.g., 'abc123'


### client.reauthenticate(auth)


Re-authenticates an existing WebSocket connection without disconnecting. Sends new credentials to the server which re-runs the auth handshake. (lib/client.js)

    await client.reauthenticate({
        headers: { authorization: 'Bearer newToken123' }
    });

| Parameter | Type | Description |
|---|---|---|
| `auth` | `object \| string` | New auth credentials. Same format as `client.connect()` `auth` option. |


### client.subscriptions()


Returns an array of all active subscription paths. (lib/client.js)

    const subs = client.subscriptions();
    console.log(subs);  // ['/items/42', '/chat/general']


### client.overrideReconnectionAuth(auth)


Updates the auth credentials used for automatic reconnection. Useful when tokens expire and need refreshing. (lib/client.js)

    client.overrideReconnectionAuth({
        headers: { authorization: 'Bearer newToken123' }
    });


### Reconnection Behavior


Nes automatically reconnects when the WebSocket connection drops, unless `reconnect: false` was set in `client.connect()`. (lib/client.js)

**Reconnection sequence:**

1. Connection drops (network failure, server restart, etc.)
2. Client waits `delay` milliseconds (default: 1000ms)
3. Attempts to reconnect with the same auth credentials
4. On failure, waits with additive backoff (adds `delay` each time) up to `maxDelay`
5. Repeats up to `retries` times
6. On successful reconnection, all active subscriptions are automatically re-established

| Option | Type | Default | Description |
|---|---|---|---|
| `reconnect` | `boolean` | `true` | Enable automatic reconnection. |
| `delay` | `number` | `1000` | Initial delay before first reconnection attempt (ms). |
| `maxDelay` | `number` | `5000` | Maximum delay between reconnection attempts (ms). |
| `retries` | `number` | `Infinity` | Maximum reconnection attempts before giving up. |

**Client events for monitoring connection state:**

    client.onConnect = () => {

        console.log('Connected');
    };

    client.onDisconnect = (willReconnect, log) => {

        // willReconnect: true if the client will attempt reconnection
        // log: { code, explanation, reason, wasClean }
        console.log('Disconnected, will reconnect:', willReconnect);
    };

    client.onHeartbeatTimeout = () => {

        console.log('Heartbeat timeout -- connection may be dead');
    };

    client.onUpdate = (message) => {

        // Receives server.broadcast() and socket.send() messages
        console.log('Update:', message);
    };

    client.onError = (err) => {

        console.log('Connection error:', err);
    };


### Socket Object (Server-Side)


Each connected client is represented by a `Socket` object on the server. Accessible in handlers via `request.socket`, in `onConnection`/`onDisconnection`, and in subscription hooks. (lib/socket.js)

| Property | Type | Description |
|---|---|---|
| `id` | `string` | Unique socket identifier. |
| `app` | `object` | Application-specific state. Safe to store custom data here. |
| `auth` | `object` | Authentication state: `{ isAuthenticated, credentials, artifacts }`. |
| `info` | `object` | Connection metadata: `{ remoteAddress, remotePort, x-forwarded-for, headers }`. The `x-forwarded-for` property is always available from the upgrade request. `headers` only includes those listed in the plugin `headers` option. (lib/socket.js) |
| `server` | `object` | Reference to the hapi server. |

    // In a route handler
    const handler = (request, h) => {

        if (request.socket) {
            // This request came over WebSocket
            request.socket.app.lastSeen = Date.now();
        }

        return { ok: true };
    };

    // In onConnection
    options: {
        onConnection: (socket) => {

            socket.app.connectedAt = Date.now();
        }
    }

**Socket methods:**

| Method | Signature | Description |
|---|---|---|
| `disconnect()` | `await socket.disconnect()` | Closes the WebSocket connection for this client. |
| `send(message)` | `await socket.send(message)` | Sends a custom message to this specific client. |
| `publish(path, message)` | `await socket.publish(path, message)` | Publishes a message to this specific socket's subscription on `path`. |
| `revoke(path, message, [options])` | `await socket.revoke(path, message, options)` | Revokes the socket's subscription on `path`, optionally sending a final message. `options.ignoreClose` prevents error when socket is already closed. (lib/socket.js) |
| `isOpen()` | `socket.isOpen()` | Returns `true` if the WebSocket connection is currently open. (lib/socket.js) |


### Gotchas


- **`client.connect()` must be called first.** Calling `request()`, `subscribe()`, or `message()` before connecting throws an error.
- **Subscriptions auto-restore on reconnect.** After reconnection, nes automatically re-subscribes to all active subscriptions. This is usually desired but can cause duplicate processing if the handler is not idempotent.
- **`client.onUpdate` receives broadcasts and direct sends.** Messages from `server.broadcast()` and `socket.send()` arrive via the `client.onUpdate` callback, not via subscription handlers.
- **`client.request()` rejects on server errors.** Unlike HTTP clients that return error responses, nes throws when the server returns 4xx/5xx. Always use try/catch.
- **`client.disconnect()` disables reconnection.** Explicit disconnect prevents automatic reconnection. The client must call `connect()` again to re-establish.
- **Token expiration on reconnect.** If using token auth and the token expires, reconnection will fail. Use `client.overrideReconnectionAuth()` to provide a fresh token before the old one expires.
- **`onMessage` must return a value.** If the server's `onMessage` handler does not return a value, the client receives `null`. Always return something meaningful.
- **The `ws` option is platform-dependent.** In the browser, WebSocket options are limited. The `ws` option is primarily useful in Node.js for TLS configuration and other `ws` library options.
- **Socket `info.headers` requires plugin `headers` option.** If you need to read request headers on the socket (e.g., `User-Agent`), you must include the header name in the nes plugin `headers` option during registration.
- **`request.socket` is only set for WebSocket requests.** For regular HTTP requests, `request.socket` is `undefined`. Check before using.

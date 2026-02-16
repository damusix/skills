## @hapi/nes WebSocket Overview


Nes is the official WebSocket plugin for hapi. It wraps hapi's HTTP listener with WebSocket upgrade support, allowing clients to make requests to hapi routes and subscribe to real-time updates -- all through a single WebSocket connection.

    const Hapi = require('@hapi/hapi');
    const Nes = require('@hapi/nes');

    const server = Hapi.server({ port: 3000 });

    await server.register(Nes);

    server.route({
        method: 'GET',
        path: '/hello',
        handler: (request, h) => {

            return { message: 'Hello from WebSocket' };
        }
    });

    await server.start();


### Registration


Nes is registered as a standard hapi plugin via `server.register()`. It attaches a WebSocket listener to the existing hapi HTTP server -- no separate port is needed. (lib/index.js)

    await server.register({
        plugin: Nes,
        options: {
            heartbeat: { interval: 15000, timeout: 5000 },
            headers: ['Authorization']
        }
    });


### Plugin Options


| Option | Type | Default | Description |
|---|---|---|---|
| `onConnection` | `function` | -- | Called when a new WebSocket client connects. Signature: `async function (socket)`. |
| `onDisconnection` | `function` | -- | Called when a client disconnects. Signature: `function (socket)`. |
| `onMessage` | `function` | -- | Handler for custom client messages sent via `client.message()`. Signature: `async function (socket, message)`. Must return a response value. |
| `heartbeat` | `object \| false` | `{ interval: 15000, timeout: 5000 }` | Controls WebSocket keep-alive pings. Set to `false` to disable. |
| `heartbeat.interval` | `number` | `15000` | Milliseconds between heartbeat pings sent to clients. |
| `heartbeat.timeout` | `number` | `5000` | Milliseconds to wait for a heartbeat response before disconnecting. |
| `headers` | `array \| string \| null` | `null` | List of header names from the initial HTTP upgrade request to expose on `socket.info.headers`. Set to `'*'` to allow all headers. Only listed headers are accessible. |
| `payload` | `object` | -- | Controls payload size limits for incoming WebSocket messages. |
| `payload.maxChunkChars` | `number` | `false` | Maximum number of characters allowed per incoming WebSocket message chunk. `false` disables the limit. (lib/index.js:30) |
| `auth` | `object` | -- | Default auth configuration for WebSocket connections. |
| `auth.type` | `string` | `'direct'` | Authentication type. `'direct'` sends credentials directly. `'token'` uses a token exchange. `'cookie'` uses the browser cookie from the upgrade request. (lib/index.js:18) |
| `auth.endpoint` | `string` | `'/nes/auth'` | The hapi route path used for WebSocket authentication when type is `'token'`. |
| `auth.id` | `string` | `'nes.auth'` | Route ID for the auth endpoint route. (lib/index.js) |
| `auth.route` | `object` | -- | Route-level auth options passed to the auth endpoint route. |
| `auth.cookie` | `string` | `'nes'` | Cookie name used when `auth.type` is `'cookie'`. (lib/index.js:19) |
| `auth.password` | `string` | -- | Password for iron-encrypting auth cookies. Required when `auth.type` is `'cookie'`. |
| `auth.iron` | `object` | -- | Iron options for cookie encryption. |
| `auth.isSecure` | `boolean` | `true` | Whether the auth cookie requires HTTPS. |
| `auth.isHttpOnly` | `boolean` | `true` | Whether the auth cookie is HTTP-only. |
| `auth.isSameSite` | `string \| false` | `'Strict'` | SameSite attribute for the auth cookie. `'Strict'`, `'Lax'`, or `false`. |
| `auth.path` | `string` | `'/'` | Cookie path. (lib/index.js) |
| `auth.domain` | `string` | -- | Cookie domain. |
| `auth.ttl` | `number` | -- | Cookie TTL in milliseconds. |
| `auth.index` | `boolean` | `false` | When `true`, authenticated sockets are indexed by user for targeted publishing. |
| `auth.timeout` | `number` | `5000` | Authentication timeout in milliseconds. (lib/index.js:25) |
| `auth.maxConnectionsPerUser` | `number` | `false` | Maximum concurrent connections per authenticated user. `false` disables the limit. (lib/index.js:26) |
| `maxConnections` | `number` | `false` | Maximum total concurrent WebSocket connections. `false` disables the limit. (lib/index.js:36) |
| `origin` | `string[]` | -- | Allowed origin hostnames for WebSocket connections. When set, the `Origin` header is validated against this list. (lib/index.js:87) |


### How Nes Wraps the HTTP Listener


Nes hooks into the hapi server's existing HTTP listener during server initialization. When a browser or nes client opens a WebSocket connection, the HTTP `upgrade` event is intercepted and handed off to the `ws` library. The underlying `http.Server` is shared -- HTTP and WebSocket traffic coexist on the same port. (lib/listener.js)

The connection lifecycle:

1. Client sends an HTTP upgrade request to the hapi server
2. Nes intercepts the `upgrade` event on the HTTP listener
3. The `ws` library completes the WebSocket handshake
4. A `Socket` object is created representing the connection (lib/socket.js)
5. If auth is configured, the client must authenticate before making requests
6. The client can now call `client.request()`, `client.subscribe()`, or `client.message()`


### Route-Level WebSocket Config


Any hapi route can be accessed over WebSocket via `client.request()`. By default, all routes are accessible. Use `route.options.plugins.nes` to control WebSocket-specific behavior:

    server.route({
        method: 'POST',
        path: '/items',
        options: {
            plugins: {
                nes: {
                    auth: {
                        mode: 'required'
                    }
                }
            },
            handler: (request, h) => {

                return { created: true };
            }
        }
    });

When a client calls `client.request({ method: 'POST', path: '/items', payload: { name: 'thing' } })`, nes creates an internal hapi request injection. The route's full lifecycle runs -- validation, auth, pre-handlers, handler, extensions -- exactly as if it were an HTTP request.


### How Nes Routes Work


`client.request()` maps directly to hapi routes. Nes serializes the request, sends it over the WebSocket, and the server injects it into hapi's request pipeline via `server.inject()`. (lib/socket.js)

    // Client side
    const response = await client.request({
        method: 'GET',
        path: '/api/users/42',
        headers: { 'x-custom': 'value' }
    });

    console.log(response.payload);    // { id: 42, name: 'John' }
    console.log(response.statusCode); // 200

Key details:

- The request goes through the full hapi lifecycle (auth, validation, extensions, handler)
- Route auth applies -- the WebSocket connection's auth credentials are used
- Response status codes and payloads are returned to the client
- `request.socket` is available in handlers to access the underlying nes socket
- Only `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` methods are supported


### Gotchas


- **Nes shares the HTTP port.** There is no separate WebSocket port. The `ws` listener piggybacks on hapi's `http.Server`.
- **All routes are WebSocket-accessible by default.** There is no opt-in per route. If you need to restrict a route to HTTP-only, check `request.socket` in the handler or use a lifecycle extension.
- **Auth on WebSocket is connection-level.** Once authenticated, the credentials apply to all requests on that socket. Use `client.reauthenticate()` to update credentials on a live connection, or `client.overrideReconnectionAuth()` to update credentials used on reconnect. See [client reference](client.md).
- **Payload size limits matter.** The `payload.maxChunkChars` option controls incoming message size. Large payloads may need this increased.
- **Heartbeat keeps connections alive.** Without heartbeat, idle connections may be dropped by proxies or load balancers. Disable only if you have another keep-alive mechanism.
- **Headers are not exposed by default.** You must explicitly list header names in the `headers` plugin option to access them via `socket.info.headers`.

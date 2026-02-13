## hapi Server Network and Lifecycle Reference


### server.bind(context)


Sets a global context used as the default `this` binding for route handlers and extension methods. Also available as `h.context`.

```js
    exports.plugin = {
        name: 'example',
        register: function (server, options) {

            server.bind({ message: 'hello' });
            server.route({
                method: 'GET',
                path: '/',
                handler: function (request, h) {

                    return this.message;     // 'hello'
                    // or: h.context.message
                }
            });
        }
    };
```

**Gotchas:**
- Inside a plugin, context applies only to that plugin's methods.
- Only applies to routes and extensions added **after** the bind call.
- Ignored if the method is an arrow function.


### server.decoder(encoding, decoder) / server.encoder(encoding, encoder)


Register custom content decoding/encoding compressors extending built-in `gzip` and `deflate` support.

**Decoder** -- for incoming request payload decompression:

```js
    const Zlib = require('zlib');

    // Server config enables per-route compression options
    const server = Hapi.server({
        port: 80,
        routes: {
            payload: {
                compression: {
                    special: { chunkSize: 16 * 1024 }
                }
            }
        }
    });

    server.decoder('special', (options) => Zlib.createGunzip(options));
```

**Encoder** -- for outgoing response compression:

```js
    const server = Hapi.server({
        port: 80,
        routes: {
            compression: {
                special: { chunkSize: 16 * 1024 }
            }
        }
    });

    server.encoder('special', (options) => Zlib.createGzip(options));
```

Both functions receive encoding-specific `options` from the route configuration and must return a stream object compatible with node's zlib transform streams.


### server.inject(options)


Injects a simulated HTTP request without a socket connection. Essential for testing. Uses the **shot** module internally.

**Shorthand:**

```js
    const res = await server.inject('/path');
```

**Full options:**

| Option           | Type                         | Default      | Description                                                                                          |
| ---------------- | ---------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `method`         | `string`                     | `'GET'`      | HTTP method                                                                                          |
| `url`            | `string`                     | **required** | Request URL. Authority in URL auto-sets Host header.                                                 |
| `authority`      | `string`                     | inferred     | HTTP Host header value. Used only if Host not in `headers` and not in `url`.                         |
| `headers`        | `object`                     | `{}`         | Request headers                                                                                      |
| `payload`        | `string \| Buffer \| object` | none         | Request body. Objects are stringified. Defaults to `application/json` Content-Type if none provided. |
| `auth`           | `object`                     | none         | Bypass authentication (see below)                                                                    |
| `app`            | `object`                     | `{}`         | Initial `request.app` value                                                                          |
| `plugins`        | `object`                     | `{}`         | Initial `request.plugins` value                                                                      |
| `allowInternals` | `boolean`                    | `false`      | Allow access to routes with `options.isInternal: true`                                               |
| `remoteAddress`  | `string`                     | none         | Remote address for the connection                                                                    |
| `simulate`       | `object`                     | none         | Simulate stream conditions (see below)                                                               |
| `validate`       | `boolean`                    | `true`       | Set `false` to skip input validation for faster runtime usage                                        |

**auth option:**

| Property      | Required | Description                                   |
| ------------- | -------- | --------------------------------------------- |
| `strategy`    | yes      | Authentication strategy name                  |
| `credentials` | yes      | Credentials object (bypasses auth scheme)     |
| `artifacts`   | no       | Auth artifacts object                         |
| `payload`     | no       | Set `false` to disable payload authentication |

**simulate option:**

| Property | Default     | Description                                     |
| -------- | ----------- | ----------------------------------------------- |
| `error`  | `false`     | Emit `'error'` event after payload transmission |
| `close`  | `false`     | Emit `'close'` event after payload transmission |
| `end`    | `true`      | Set `false` to keep stream open                 |
| `split`  | `undefined` | Chunk the request payload                       |

**Response object:**

| Property     | Type     | Description                                                                              |
| ------------ | -------- | ---------------------------------------------------------------------------------------- |
| `statusCode` | `number` | HTTP status code                                                                         |
| `headers`    | `object` | Response headers                                                                         |
| `payload`    | `string` | Response body as string                                                                  |
| `rawPayload` | `Buffer` | Response body as buffer                                                                  |
| `result`     | `any`    | Raw handler return value before serialization. Falls back to `payload` if not available. |
| `request`    | `object` | The request object                                                                       |
| `raw.req`    | `object` | Simulated node request                                                                   |
| `raw.res`    | `object` | Simulated node response                                                                  |

**Common testing patterns:**

```js
    // Simple GET
    const res = await server.inject('/users');
    console.log(res.statusCode);    // 200
    console.log(res.result);        // parsed handler return value

    // POST with payload
    const res = await server.inject({
        method: 'POST',
        url: '/users',
        payload: { name: 'Test', email: 'test@example.com' }
    });

    // With authentication bypass
    const res = await server.inject({
        method: 'GET',
        url: '/admin/dashboard',
        auth: {
            strategy: 'session',
            credentials: { id: 'user-1', scope: ['admin'] }
        }
    });

    // Access internal routes
    const res = await server.inject({
        method: 'GET',
        url: '/internal/health',
        allowInternals: true
    });

    // Custom remote address
    const res = await server.inject({
        method: 'GET',
        url: '/geo',
        remoteAddress: '192.168.1.1'
    });
```

Throws a Boom error if request processing fails. The partial response object is available on the error's `data` property.


### server.initialize()


Initializes the server: starts caches, finalizes plugin registration. Does **not** start listening on the port.

```js
    const server = Hapi.server({ port: 80 });
    await server.initialize();
    // Server is ready for inject() but not accepting network requests
```

**Primary use case:** Testing. Call `initialize()` instead of `start()` to use `server.inject()` without binding to a port.

**Gotcha:** If initialization fails, the server is in an undefined state. Call `server.stop()` to reset before retrying, or (recommended) abort the process.


### server.start()


Starts listening for incoming requests on the configured port.

```js
    const server = Hapi.server({ port: 80 });
    await server.start();
    console.log('Server running at:', server.info.uri);
```

**Gotchas:**
- If `start()` fails, the server is in an undefined state. Call `server.stop()` before retrying.
- Calling `start()` on an already-started server is a no-op (no events emitted, no extensions fired).
- Set `autoListen: false` in server options to skip port binding (e.g., for internal-only servers).


### server.stop([options])


Stops the server by refusing new connections. Existing connections continue until closed or timeout.

| Option    | Type     | Default | Description                                                                                                                                                                                     |
| --------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout` | `number` | `5000`  | Milliseconds before forcefully terminating open connections. Ignored if `server.options.operations.cleanStop` is `false`. When using `server.control()`, timeout applies per controlled server. |

```js
    await server.stop({ timeout: 60 * 1000 });
    console.log('Server stopped');
```

**Gotcha:** The timeout only applies to waiting for existing connections. `onPreStop` and `onPostStop` extensions can delay or block shutdown indefinitely.


### server.state(name, [options])


Registers a cookie definition for HTTP state management (RFC 6265).

**Cookie options:**

| Option          | Type                                   | Default       | Description                                                                                             |
| --------------- | -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `ttl`           | `number`                               | `null`        | Time-to-live in ms. `null` = session cookie (deleted on browser close).                                 |
| `isSecure`      | `boolean`                              | `true`        | Sets the `Secure` flag.                                                                                 |
| `isHttpOnly`    | `boolean`                              | `true`        | Sets the `HttpOnly` flag.                                                                               |
| `isSameSite`    | `false \| 'Strict' \| 'Lax' \| 'None'` | `'Strict'`    | Sets the `SameSite` flag. `false` = no flag.                                                            |
| `isPartitioned` | `boolean`                              | `false`       | Sets the `Partitioned` flag (CHIPS). Requires `isSecure: true` and `isSameSite: 'None'`.                |
| `path`          | `string`                               | `null`        | Cookie path scope.                                                                                      |
| `domain`        | `string`                               | `null`        | Cookie domain scope.                                                                                    |
| `encoding`      | `string`                               | `'none'`      | `'none'`, `'base64'`, `'base64json'`, `'form'`, or `'iron'`                                             |
| `sign`          | `object`                               | none          | HMAC settings: `{ integrity, password }`. Password must be >= 32 chars. Redundant with `iron` encoding. |
| `password`      | `string`                               | none          | Password for `iron` encoding (must be >= 32 chars).                                                     |
| `iron`          | `object`                               | iron defaults | Options for `iron` encoding.                                                                            |
| `autoValue`     | `any \| async function(request)`       | none          | Automatically set cookie if not received from client or set by handler.                                 |
| `ignoreErrors`  | `boolean`                              | `false`       | Treat parsing errors as missing cookies.                                                                |
| `clearInvalid`  | `boolean`                              | `false`       | Instruct client to remove invalid cookies.                                                              |
| `strictHeader`  | `boolean`                              | `true`        | Enforce RFC 6265 cookie value rules.                                                                    |
| `passThrough`   | `boolean`                              | --            | Used by proxy plugins (e.g., h2o2).                                                                     |
| `contextualize` | `async function(definition, request)`  | none          | Override cookie settings per-request.                                                                   |

```js
    server.state('session', {
        ttl: 24 * 60 * 60 * 1000,     // 1 day
        isSecure: true,
        isHttpOnly: true,
        isSameSite: 'Lax',
        path: '/',
        encoding: 'iron',
        password: 'a-password-that-is-at-least-32-characters-long'
    });

    // In route handler:
    const handler = function (request, h) {

        let session = request.state.session;
        if (!session) {
            session = { user: 'joe' };
        }

        session.last = Date.now();
        return h.response('Success').state('session', session);
    };
```

**Encoding options explained:**

| Encoding       | Input Type | Behavior                                                      |
| -------------- | ---------- | ------------------------------------------------------------- |
| `'none'`       | `string`   | No encoding. Value must be a string.                          |
| `'base64'`     | `string`   | Base64-encoded string.                                        |
| `'base64json'` | `object`   | JSON-stringified then Base64-encoded.                         |
| `'form'`       | `object`   | URL-encoded (x-www-form-urlencoded).                          |
| `'iron'`       | `any`      | Encrypted and signed using `@hapi/iron`. Requires `password`. |

**Listening for cookie parse errors:**

```js
    server.events.on({ name: 'request', channels: 'internal' }, (request, event, tags) => {

        if (tags.error && tags.state) {
            console.error(event);
        }
    });
```


### server.validator(validator)


Registers a validation module (e.g., **joi**) used to compile raw validation rules into schemas for all routes.

```js
    const Joi = require('joi');
    server.validator(Joi);
```

**Gotchas:**
- Only used when validation rules are not already pre-compiled schemas. If a rule is a function or schema object, it is used as-is.
- When set inside a plugin, the validator only applies to routes defined by that plugin and its sub-plugins.


### server.control(server)


Links another server's lifecycle to the current server. When the current server is initialized, started, or stopped, the controlled server's corresponding method is called automatically.

```js
    const main = Hapi.server({ port: 80 });
    const admin = Hapi.server({ port: 8080 });

    main.control(admin);

    await main.start();
    // Both servers are now running

    await main.stop();
    // Both servers are now stopped
```

**Gotcha:** When using `server.stop()` with a timeout, the timeout applies independently to each controlled server and the controlling server itself.

## @hapi/yar Session Management Reference


Yar is a hapi plugin for cookie-based session management. It decorates every `request` with a `request.yar` interface for reading and writing session data, and decorates `server` with `server.yar` for session revocation. Sessions are encrypted via `@hapi/iron` and stored either entirely in the cookie or in a server-side catbox cache.

    const Hapi = require('@hapi/hapi');
    const Yar = require('@hapi/yar');

    const server = Hapi.server({ port: 3000 });

    await server.register({
        plugin: Yar,
        options: {
            storeBlank: false,
            cookieOptions: {
                password: 'the-password-must-be-at-least-32-characters-long',
                isSecure: true
            }
        }
    });


### Registration Options


| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `'session'` | Cookie name used by yar. |
| `storeBlank` | `boolean` | `true` | If `false`, empty sessions are not stored (no cookie set until data is written). |
| `maxCookieSize` | `number` | `1024` | Maximum cookie size in bytes before session data overflows to server-side cache. Set to `0` to always use server-side storage. |
| `cache` | `object` | `{ expiresIn: 86400000 }` | Catbox cache configuration. Accepts `expiresIn`, `cache` (named cache engine), and `segment` properties as used by `server.cache()`. The segment is set automatically to `'yar_' + name`. See [server cache](cache.md). |
| `errorOnCacheNotReady` | `boolean` | `true` | If `true`, throws a 500 error when the cache is not ready. If `false`, cookie-only mode is used as fallback. |
| `customSessionIDGenerator` | `function(request)` | -- | Function that returns a custom session ID string. Receives the hapi `request` object. Must return a unique string. |
| `cookieOptions` | `object` | -- | **Required.** Passed directly to hapi's `server.state()`. See cookie options below. |


### Cookie Options (cookieOptions)


The `cookieOptions` object is passed to hapi's `server.state()` under the hood. The `password` property is required for `@hapi/iron` encryption.

| Option | Type | Default | Description |
|---|---|---|---|
| `password` | `string \| object` | -- | **Required.** Encryption password for `@hapi/iron`. Must be at least 32 characters. For key rotation, pass an object with `{ id, secret }` entries. |
| `isSecure` | `boolean` | `true` | If `true`, cookie is only sent over HTTPS. Set to `false` for development over HTTP. |
| `isHttpOnly` | `boolean` | `false` | If `true`, cookie is inaccessible to client-side JavaScript. |
| `ttl` | `number` | `null` (session cookie) | Cookie time-to-live in milliseconds. `null` creates a session cookie that expires when the browser closes. |
| `path` | `string` | `'/'` | Cookie path scope. |
| `domain` | `string` | -- | Cookie domain scope. |
| `isSameSite` | `string` | `'Lax'` | SameSite attribute: `'Strict'`, `'Lax'`, or `'None'`. (lib/index.js:16) |
| `clearInvalid` | `boolean` | `true` | If `true`, invalid cookies are removed automatically. (lib/index.js:14) |
| `ignoreErrors` | `boolean` | `true` | If `true`, errors in cookie parsing are ignored and the cookie is cleared. (lib/index.js:15) |
| `strictHeader` | `boolean` | `true` | If `true`, enforces strict RFC 6265 header compliance. |
| `contextualize` | `function` | -- | Function `async (definition, request)` called on each request to modify the cookie definition dynamically. |

**Dynamic isSecure based on environment:**

    const options = {
        cookieOptions: {
            password: 'the-password-must-be-at-least-32-characters-long',
            isSecure: process.env.NODE_ENV !== 'development'
        }
    };


### request.yar API


The `yar` property is added as a request decoration by the plugin. It provides session read/write methods on every request.


**`request.yar.id`** -- the current session ID string. Read-only.

    const handler = (request, h) => {

        return { sessionId: request.yar.id };
    };

**`request.yar.set(key, value)`** -- assigns a value to a session key. Returns the value. (API.md)

    request.yar.set('user', { name: 'Eran', role: 'admin' });

**`request.yar.set(keysObject)`** -- assigns multiple keys from the top-level properties of the object. Returns the object. (API.md)

    request.yar.set({ user: 'Eran', role: 'admin' });

**`request.yar.get(key, [clear])`** -- retrieves a session value by key. If `clear` is `true`, the key is removed after reading. (API.md)

    const user = request.yar.get('user');

    // Get and delete in one step
    const token = request.yar.get('onetimeToken', true);

**`request.yar.clear(key)`** -- removes a specific key from the session. (API.md)

    request.yar.clear('user');

**`request.yar.reset()`** -- clears all session data and assigns a new session ID. (API.md)

    request.yar.reset();

**`request.yar.touch()`** -- manually marks the session as modified. Required when you mutate a retrieved reference directly without calling `set()`. (API.md)

    const cart = request.yar.get('cart');
    cart.items.push(newItem);
    request.yar.touch();    // Without this, changes may not persist

**`request.yar.flash(type, message, isOverride)`** -- flash message system for volatile one-time data. (API.md)

| Call Signature | Behavior |
|---|---|
| `flash()` | Returns all flash messages (all types) and deletes them. |
| `flash(type)` | Returns flash messages of the given type and deletes them. |
| `flash(type, message)` | Appends message to the given type. |
| `flash(type, message, true)` | Replaces all messages of the given type with the single message. |

    // Setting flash messages (in handler A)
    request.yar.flash('success', 'Item saved');
    request.yar.flash('success', 'Email sent');

    // Reading flash messages (in handler B -- next request)
    const messages = request.yar.flash('success');
    // ['Item saved', 'Email sent']
    // Messages are now deleted from the session

**`request.yar.lazy(enabled)`** -- enables lazy mode when `enabled` is `true`. In lazy mode, you can set properties directly on `request.yar` and they persist automatically. (API.md)

    request.yar.lazy(true);
    request.yar.myKey = 'myValue';
    // Automatically persisted without calling set()

Lazy mode stores the entire session state on every response regardless of whether changes occurred, so it is slower than explicit `get`/`set` calls.

**`request.yar.commit(h)`** -- manually commits the session state into the response. Requires the hapi response toolkit `h`. (API.md)

    server.ext('onPreResponse', async (request, h) => {

        // Do something that modifies the session
        request.yar.set('lastAccess', Date.now());

        await request.yar.commit(h);
        return h.continue;
    });

Normally yar's built-in `onPreResponse` handler calls `commit` automatically. Use this only when you need to commit within your own `onPreResponse` extension that runs before yar's.


### server.yar API


**`server.yar.revoke(id)`** -- revokes the session with the given ID, invalidating it. (API.md)

    // Revoke a specific user's session (e.g., from an admin panel)
    await server.yar.revoke(sessionId);

This only works when server-side cache storage is enabled (i.e., when `maxCookieSize` would cause overflow or is set to `0`).


### Cookie Encryption via @hapi/iron


Yar uses hapi's built-in state management with `encoding: 'iron'`, which delegates encryption to `@hapi/iron`. Iron provides authenticated encryption:

1. The session data is serialized to JSON
2. Encrypted with AES-256-CBC using a key derived from the password
3. An HMAC-SHA256 integrity signature is appended
4. The result is Base64url-encoded and set as the cookie value

The `password` must be at least 32 characters. For key rotation, provide an object mapping key IDs to secrets:

    const options = {
        cookieOptions: {
            password: {
                v1: 'old-password-must-be-at-least-32-characters-long',
                v2: 'new-password-must-be-at-least-32-characters-long'
            },
            isSecure: true
        }
    };


### Server-Side Cache Storage


When session data exceeds `maxCookieSize` (default 1024 bytes), yar stores the data in a server-side catbox cache and only puts the session ID in the cookie. Set `maxCookieSize: 0` to always use server-side storage.

**Using the default in-memory cache:**

    await server.register({
        plugin: Yar,
        options: {
            maxCookieSize: 0,
            cookieOptions: {
                password: 'the-password-must-be-at-least-32-characters-long',
                isSecure: true
            }
        }
    });

**Using a named cache engine (e.g., Redis):**

    const server = Hapi.server({
        port: 3000,
        cache: [{
            name: 'redis-cache',
            provider: {
                constructor: require('@hapi/catbox-redis'),
                options: { host: '127.0.0.1', port: 6379 }
            }
        }]
    });

    await server.register({
        plugin: Yar,
        options: {
            maxCookieSize: 0,
            cache: {
                cache: 'redis-cache',
                segment: 'sessions'
            },
            cookieOptions: {
                password: 'the-password-must-be-at-least-32-characters-long',
                isSecure: true
            }
        }
    });

See [server cache](cache.md) for catbox engine configuration details, and [catbox-redis engine](catbox-redis.md) for Redis-specific options.


### Flash Messages


Flash messages are volatile session data -- written on one request and consumed (deleted) on the next. Common for post-redirect-get patterns showing success/error notifications.

    // POST handler -- save and redirect
    const submitHandler = (request, h) => {

        await saveItem(request.payload);
        request.yar.flash('success', 'Item created successfully');
        return h.redirect('/items');
    };

    // GET handler -- display flash messages
    const listHandler = (request, h) => {

        const flashes = request.yar.flash('success');
        return h.view('items/list', {
            items: await getItems(),
            messages: flashes
        });
    };

Flash messages accumulate per type until read. Calling `flash(type, message, true)` replaces instead of appending.


### Custom Session ID Generation


Provide a `customSessionIDGenerator` function to control session ID format:

    const Uuid = require('uuid');

    await server.register({
        plugin: Yar,
        options: {
            customSessionIDGenerator: (request) => {

                return Uuid.v4();
            },
            cookieOptions: {
                password: 'the-password-must-be-at-least-32-characters-long',
                isSecure: true
            }
        }
    });

The function receives the hapi `request` object and must return a unique string.


### Route-Level Skip


Yar processing can be skipped for specific routes using the `skip` plugin option. When `true`, yar does not load or save session state for that request. (lib/index.js:109-113)

    server.route({
        method: 'GET',
        path: '/healthcheck',
        options: {
            plugins: {
                yar: { skip: true }
            }
        },
        handler: (request, h) => 'ok'
    });


### Gotchas


- **Password must be at least 32 characters.** This is enforced by `@hapi/iron`. Shorter passwords cause a registration error.
- **`isSecure: true` is the default.** If you are developing locally over HTTP, requests will not include the cookie. Set `isSecure: false` for development only.
- **`touch()` is required for mutated references.** If you `get()` an object and modify it in place, yar does not detect the change. Call `touch()` or use `set()` again.
- **`storeBlank: true` creates sessions for every visitor.** Set to `false` to avoid creating sessions for unauthenticated or anonymous users who never write session data.
- **`encoding` cannot be overridden.** Yar asserts that `cookieOptions.encoding` is not set and forces `'iron'` internally. (lib/index.js:39-44) Passing `encoding` in `cookieOptions` throws at registration.
- **`maxCookieSize` overflow is silent.** When session data exceeds the limit, yar switches to server-side storage automatically. If no cache is configured, this causes errors.
- **Lazy mode stores on every response.** Using `lazy(true)` persists the full session state on every request, even if nothing changed. Prefer explicit `get`/`set` for performance.
- **Flash messages are deleted on read.** Calling `flash(type)` returns and removes those messages. If the response fails after reading, the messages are lost.
- **`commit(h)` is rarely needed.** Yar's built-in `onPreResponse` extension handles session commit. Only use `commit(h)` when your own `onPreResponse` must write session data before yar's extension runs.
- **`server.yar.revoke(id)` requires server-side cache.** Revocation only works when sessions are stored in catbox. Cookie-only sessions cannot be revoked server-side.
- **Yar is a plugin, not a utility.** Register via `server.register()`, do not import and call directly. Compare with [Boom](../lifecycle/boom.md) which is a standalone utility.

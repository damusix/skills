## @hapi/basic -- HTTP Basic Authentication Scheme


`@hapi/basic` is a hapi plugin that registers an authentication scheme called `'basic'`. It implements HTTP Basic authentication (RFC 7617), parsing the `Authorization: Basic <base64(username:password)>` header and delegating credential validation to a user-provided `validate` function.

    const Hapi = require('@hapi/hapi');
    const Basic = require('@hapi/basic');

    const server = Hapi.server({ port: 3000 });

    await server.register(Basic);

    server.auth.strategy('simple', 'basic', {
        validate: async (request, username, password, h) => {

            const user = await getUser(username);
            if (!user || !await verify(password, user.hash)) {
                return { isValid: false };
            }

            return { isValid: true, credentials: { id: user.id, name: user.name } };
        }
    });

    server.auth.default('simple');

`@hapi/basic` **is a plugin** -- it must be registered via `server.register()`. It registers a scheme named `'basic'`, from which you create strategies using `server.auth.strategy()`.


### Registration


Register the plugin before creating strategies:

    await server.register(require('@hapi/basic'));

This calls `server.auth.scheme('basic', internals.implementation)` internally, making the `'basic'` scheme available for `server.auth.strategy()`.

You can register it within a plugin or at the top-level server -- the scheme becomes globally available regardless of plugin realm.


### `server.auth.strategy(name, 'basic', options)`


Creates a named strategy from the `'basic'` scheme.

| Option | Type | Default | Description |
|---|---|---|---|
| `validate` | `async function(request, username, password, h)` | **required** | Credential validation function. |
| `allowEmptyUsername` | `boolean` | `false` | When `true`, allows requests with an empty username (empty string before the `:` in the decoded credentials). |
| `unauthorizedAttributes` | `object` | `undefined` | Additional attributes included in the `WWW-Authenticate` header on 401 responses (e.g., `{ realm: 'my-app' }`). |

    server.auth.strategy('simple', 'basic', {
        validate: myValidateFunction,
        allowEmptyUsername: false,
        unauthorizedAttributes: { realm: 'api' }
    });


### The `validate` Function


The core of `@hapi/basic`. Called on every request that uses a Basic auth strategy.

**Signature:** `async function(request, username, password, h)`

| Parameter | Type | Description |
|---|---|---|
| `request` | `Request` | The hapi request object. |
| `username` | `string` | The username decoded from the `Authorization` header. |
| `password` | `string` | The password decoded from the `Authorization` header. |
| `h` | `ResponseToolkit` | The hapi response toolkit. |

**Return value:** An object with these properties:

| Property | Type | Required | Description |
|---|---|---|---|
| `isValid` | `boolean` | **Yes** | `true` if the credentials are valid, `false` otherwise. |
| `credentials` | `object` | No | The credential object set on `request.auth.credentials`. Should contain user identity and scope. If omitted when `isValid` is `true`, an empty credentials object is used. |
| `response` | `Response` | No | A takeover response (e.g., `h.response().redirect()`). When provided, it is used immediately as the response, bypassing further auth processing. Useful for redirecting to a login page. |

**Examples:**

    // Simple validation
    const validate = async (request, username, password, h) => {

        const user = await db.users.findOne({ username });
        if (!user) {
            return { isValid: false };
        }

        const isMatch = await Bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
            return { isValid: false };
        }

        return {
            isValid: true,
            credentials: {
                id: user.id,
                name: user.name,
                scope: user.roles
            }
        };
    };

    // With takeover response (redirect to login)
    const validate = async (request, username, password, h) => {

        const user = await db.users.findOne({ username });
        if (!user) {
            return { isValid: false, response: h.response().redirect('/login') };
        }

        const isMatch = await Bcrypt.compare(password, user.passwordHash);
        return {
            isValid: isMatch,
            credentials: { id: user.id, name: user.name }
        };
    };


### How the Authorization Header Is Parsed


The plugin extracts and decodes the `Authorization` header as follows:

1. Reads `request.headers.authorization`.
2. Checks for the `Basic` scheme prefix (case-insensitive).
3. Base64-decodes the token portion: `Buffer.from(token, 'base64').toString('utf8')`.
4. Splits on the **first** `:` character -- everything before is the username, everything after is the password. This means passwords can contain `:` characters.
5. If `allowEmptyUsername` is `false` (default) and the username is empty, authentication fails.
6. Calls the `validate` function with the parsed username and password.


### Unauthorized Response Behavior


When authentication fails, `@hapi/basic` returns a `Boom.unauthorized` error with a `WWW-Authenticate` header:

- **Missing or malformed `Authorization` header:** Returns `Boom.unauthorized(null, 'Basic', unauthorizedAttributes)`. The `null` message means "not applicable" -- in a multi-strategy setup, hapi will try the next strategy. See [boom errors](../lifecycle/boom.md#boomunauthorized----auth-specific-usage).
- **Empty username (when `allowEmptyUsername` is `false`):** Same as above -- `Boom.unauthorized(null, 'Basic', unauthorizedAttributes)`.
- **`validate` returns `{ isValid: false }`:** Returns `Boom.unauthorized('Bad username or password', 'Basic', unauthorizedAttributes)`. The string message means definitive failure -- hapi stops trying other strategies.
- **`validate` throws an error:** The error is passed through as-is (boomified if not already a Boom error), wrapped with the credentials as `error.output.payload.attributes`.

The `WWW-Authenticate` response header follows the format:

    WWW-Authenticate: Basic realm="api"

Where realm and other attributes come from the `unauthorizedAttributes` option.


### Integration with Hapi Auth System


After successful authentication, the credentials and artifacts are available on the request:

| Property | Description |
|---|---|
| `request.auth.isAuthenticated` | `true` when authentication succeeded. |
| `request.auth.credentials` | The `credentials` object returned by `validate`. |
| `request.auth.artifacts` | Not set by `@hapi/basic` (remains `undefined`). Basic auth has no artifacts beyond the credentials themselves. |
| `request.auth.strategy` | The name of the strategy that authenticated the request. |

    server.route({
        method: 'GET',
        path: '/profile',
        handler: (request, h) => {

            const { id, name, scope } = request.auth.credentials;
            return { id, name, scope };
        }
    });

The credentials integrate with hapi's scope and entity access control. Set `scope` on the credentials object to enable scope-based route authorization. See [route auth](../route/auth.md) for scope and entity configuration.


### Complete Example


    const Hapi = require('@hapi/hapi');
    const Basic = require('@hapi/basic');
    const Bcrypt = require('bcrypt');

    const users = {
        admin: {
            id: '1',
            name: 'Admin User',
            passwordHash: '$2b$10$...',  // bcrypt hash
            roles: ['admin', 'user']
        }
    };

    const validate = async (request, username, password, h) => {

        const user = users[username];
        if (!user) {
            return { isValid: false };
        }

        const isValid = await Bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
            return { isValid: false };
        }

        return {
            isValid: true,
            credentials: {
                id: user.id,
                name: user.name,
                scope: user.roles
            }
        };
    };

    const init = async () => {

        const server = Hapi.server({ port: 3000 });

        await server.register(Basic);

        server.auth.strategy('simple', 'basic', { validate });
        server.auth.default('simple');

        server.route({
            method: 'GET',
            path: '/admin',
            options: {
                auth: {
                    strategy: 'simple',
                    access: { scope: ['admin'] }
                },
                handler: (request, h) => {

                    return { admin: true, user: request.auth.credentials.name };
                }
            }
        });

        server.route({
            method: 'GET',
            path: '/info',
            options: {
                auth: { mode: 'optional' },
                handler: (request, h) => {

                    if (request.auth.isAuthenticated) {
                        return { user: request.auth.credentials.name };
                    }

                    return { anonymous: true };
                }
            }
        });

        await server.start();
    };

    init();


### Gotchas


- **`validate` must always return an object with `isValid`.** Returning `undefined` or omitting `isValid` causes the scheme to throw a 500 error. Always return `{ isValid: false }` for failed validation, not a falsy value.
- **Passwords can contain colons.** The header is split on the first `:` only, so `user:pass:word` yields username `user` and password `pass:word`.
- **Empty username is rejected by default.** A credential string of `:password` (empty username) fails unless `allowEmptyUsername: true` is set. This is a security safeguard.
- **`credentials` should include `scope` for authorization.** The `credentials` object returned by `validate` is what hapi checks against route-level `scope` and `entity` rules. If you need scope-based access control, set `credentials.scope` as an array of strings.
- **`request.auth.artifacts` is not used.** Unlike token-based schemes, Basic auth does not set artifacts. Do not rely on `request.auth.artifacts` when using `@hapi/basic`.
- **Base64 encoding is not encryption.** Basic auth transmits credentials in base64, which is trivially decodable. Always use HTTPS in production.
- **`validate` errors are boomified.** If `validate` throws a non-Boom error, it becomes a 500. Throw `Boom.unauthorized()` or `Boom.forbidden()` for intentional auth failures with specific status codes. See [boom errors](../lifecycle/boom.md).
- **Multi-strategy fallthrough.** When no `Authorization` header is present (or it is not `Basic`), the scheme returns `Boom.unauthorized(null, 'Basic')` which allows hapi to try the next strategy. When credentials are invalid, it returns a message, stopping the chain. See [server auth](../server/auth.md) for multi-strategy behavior.
- **The `response` takeover from `validate` bypasses lifecycle.** When `validate` returns a `response` property, that response is used immediately. No `onPreResponse` or other lifecycle extensions run on it.
- **`unauthorizedAttributes` vs `Boom.unauthorized` attributes.** The `unauthorizedAttributes` option is passed directly to `Boom.unauthorized()` as the third argument. Keys become `WWW-Authenticate` header attributes. The most common attribute is `realm`.

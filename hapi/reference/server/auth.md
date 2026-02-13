
## hapi Authentication Reference


Use when implementing auth schemes, registering strategies, setting defaults, or testing/verifying credentials.


### Architecture Overview


Authentication in hapi has three layers:

1. **Scheme** -- a general authentication protocol (e.g., "bearer token", "cookie"). Registered via `server.auth.scheme()`.
2. **Strategy** -- a named instance of a scheme with specific options (e.g., "jwt" using "bearer" scheme with a secret). Registered via `server.auth.strategy()`.
3. **Default** -- the strategy applied to all routes unless overridden. Set via `server.auth.default()`.

You must register schemes before strategies, and strategies before setting defaults.


### `server.auth.scheme(name, scheme)`


Registers an authentication scheme.

| Parameter | Type                        | Description                                                   |
| --------- | --------------------------- | ------------------------------------------------------------- |
| `name`    | `string`                    | The scheme name                                               |
| `scheme`  | `function(server, options)` | Factory function that returns an authentication scheme object |

The `scheme` function receives:
- `server` -- a server reference with its own realm (parent is the realm of the server where `server.auth.strategy()` is called).
- `options` -- the options passed to `server.auth.strategy()`.

Returns: nothing.

The factory must return an **authentication scheme object**.


### Authentication Scheme Object


The object returned by the scheme factory function:

| Property                   | Required | Type           | Description                                                                 |
| -------------------------- | -------- | -------------- | --------------------------------------------------------------------------- |
| `authenticate(request, h)` | **Yes**  | async function | Main authentication lifecycle method                                        |
| `payload(request, h)`      | No       | async function | Validates the request payload after parsing                                 |
| `response(request, h)`     | No       | async function | Decorates response with auth headers before sending                         |
| `verify(auth)`             | No       | async function | Checks if previously valid credentials are still valid                      |
| `api`                      | No       | object         | Exposed via `server.auth.api[strategyName]`                                 |
| `options.payload`          | No       | boolean        | If `true`, requires payload validation and forbids routes from disabling it |


#### `authenticate(request, h)`


The core authentication method. Must return one of:

- `h.authenticated({ credentials, artifacts })` -- authentication succeeded.
- `h.unauthenticated(error, { credentials, artifacts })` -- authentication failed.
- Throw a Boom error -- authentication failed.

The `credentials` object is where you put user/app identity. The `artifacts` object is for authentication-related data that is not part of the user identity (e.g., raw tokens, session IDs).

**Key behavior for multiple strategies:** When a route has multiple strategies, the error format determines whether the next strategy is tried:

| Error Format                            | Next Strategy Attempted?                               |
| --------------------------------------- | ------------------------------------------------------ |
| `Boom.unauthorized('Invalid token')`    | **No** -- message means definitive failure             |
| `Boom.unauthorized(null, 'SchemeName')` | **Yes** -- no message means "not applicable, try next" |

When authentication fails across all strategies, the scheme names appear in the `WWW-Authenticate` response header.

```javascript
const scheme = function (server, options) {

    return {
        authenticate: function (request, h) {

            const authorization = request.headers.authorization;
            if (!authorization) {
                // No message + scheme name = try next strategy
                throw Boom.unauthorized(null, 'Custom');
            }

            // Validate token...
            if (!valid) {
                // Message = stop trying other strategies
                throw Boom.unauthorized('Invalid credentials');
            }

            return h.authenticated({
                credentials: {
                    user: { id: userId, name: userName },
                    scope: ['user']
                },
                artifacts: { token: authorization }
            });
        }
    };
};
```


#### `payload(request, h)`


Called after the payload is parsed. Used to verify payload integrity (e.g., signature verification).

**Key behavior:**

| Error Format                                 | Result                                              |
| -------------------------------------------- | --------------------------------------------------- |
| `Boom.unauthorized('Bad payload signature')` | Payload validation failed                           |
| `Boom.unauthorized(null, 'SchemeName')`      | May succeed if route `auth.payload` is `'optional'` |

```javascript
return {
    authenticate: function (request, h) { /* ... */ },
    payload: function (request, h) {

        // Verify payload signature using auth artifacts
        const signature = request.headers['x-payload-signature'];
        const expected = computeSignature(request.payload, request.auth.artifacts.secret);

        if (signature !== expected) {
            throw Boom.unauthorized('Invalid payload signature');
        }

        return h.continue;
    }
};
```


#### `response(request, h)`


Called before the response headers/payload are written. Used to add authentication-related response headers.

```javascript
return {
    authenticate: function (request, h) { /* ... */ },
    response: function (request, h) {

        request.response.header('X-Auth-Token', request.auth.artifacts.refreshedToken);
        return h.continue;
    }
};
```


#### `verify(auth)`


Called to check if credentials are still valid (e.g., not expired or revoked). Receives the `request.auth` object containing `credentials` and `artifacts`. Does **not** have access to the original request.

Throw an error if credentials are no longer valid.

```javascript
return {
    authenticate: function (request, h) { /* ... */ },
    verify: async function (auth) {

        const token = auth.artifacts.token;
        const isRevoked = await tokenStore.isRevoked(token);
        if (isRevoked) {
            throw Boom.unauthorized('Token revoked');
        }
    }
};
```


#### `api`


An object exposed via `server.auth.api[strategyName]`. Useful for exposing configuration or utility methods from the auth scheme to application code.

```javascript
const scheme = function (server, options) {

    return {
        api: {
            generateToken: (user) => jwt.sign(user, options.secret),
            settings: options
        },
        authenticate: function (request, h) { /* ... */ }
    };
};

server.auth.scheme('jwt', scheme);
server.auth.strategy('default', 'jwt', { secret: 'my-secret' });

// Access the API from anywhere:
const token = server.auth.api.default.generateToken({ id: '123' });
```


### `server.auth.strategy(name, scheme, [options])`


Registers a named authentication strategy as an instance of a scheme.

| Parameter | Type     | Description                                                      |
| --------- | -------- | ---------------------------------------------------------------- |
| `name`    | `string` | Strategy name (used in route config and `server.auth.default()`) |
| `scheme`  | `string` | A previously registered scheme name                              |
| `options` | `object` | Passed to the scheme factory as its second argument              |

Returns: nothing.

```javascript
server.auth.scheme('bearer', bearerScheme);

// Multiple strategies from the same scheme with different options
server.auth.strategy('user-jwt', 'bearer', {
    secret: process.env.USER_JWT_SECRET,
    audience: 'users'
});

server.auth.strategy('admin-jwt', 'bearer', {
    secret: process.env.ADMIN_JWT_SECRET,
    audience: 'admins'
});
```


### `server.auth.default(options)`


Sets the default authentication strategy applied to every route.

| Parameter | Type                 | Description                              |
| --------- | -------------------- | ---------------------------------------- |
| `options` | `string` or `object` | Strategy name or full auth config object |

Returns: nothing.

When `options` is a string, it is the strategy name. When an object, it follows the same format as the route `auth` config.

**Key behaviors:**

- Routes with `auth: false` are **not** affected by the default.
- Routes that specify their own `strategy` or `strategies` are **not** affected.
- Routes with partial auth config (e.g., only `scope`) get the default merged in.
- The default is applied at the time the route is added, **not** at runtime.

**Gotcha:** Calling `server.auth.default()` after `server.route()` will affect routes added before the call only if those routes had **no** auth config at all. Routes that already had partial auth config will **not** be retroactively updated.

The current default is accessible via `server.auth.settings.default`.

Use `server.auth.lookup(request.route)` to get the active auth configuration for a route.

```javascript
// String form
server.auth.default('user-jwt');

// Object form with mode
server.auth.default({
    strategy: 'user-jwt',
    mode: 'optional'
});

// Object form with multiple strategies
server.auth.default({
    strategies: ['user-jwt', 'admin-jwt'],
    mode: 'try'
});
```


### Auth Modes


| Mode         | Behavior                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `'required'` | (default) Request must be authenticated. Fails with 401 if not                                                                             |
| `'optional'` | Authentication is attempted. If credentials are provided and invalid, fails with 401. If no credentials, request continues unauthenticated |
| `'try'`      | Like `'optional'`, but invalid credentials still allow the request to continue. `request.auth.isAuthenticated` will be `false`             |


### Scope Configuration


The `scope` property in a route's `auth.access` config defines which credential scopes are required to access the route. Scopes are matched against `credentials.scope` (an array of scope strings set during authentication).

**Basic scope:** A plain string requires the scope to be present in `credentials.scope`.

**Dynamic scope with `+` prefix:** The `+` prefix requires the scope to be present at the time of the request. This is functionally equivalent to a basic scope string but explicitly marks it as a required dynamic scope.

**Forbidden scope with `!` prefix:** The `!` prefix means the scope must NOT be present in `credentials.scope`. If the credential has a forbidden scope, access is denied.

**Parameter interpolation with `{param}`:** Scopes can reference request parameters using `{params.name}`, `{query.name}`, or `{payload.name}`. The value is substituted at runtime, allowing scopes to be derived from the request.

```javascript
server.route({
    method: 'GET',
    path: '/user/{id}',
    options: {
        auth: {
            strategy: 'default',
            access: {
                scope: [
                    'admin',              // must have 'admin'
                    '+supervisor',        // must have 'supervisor' (dynamic required)
                    '!guest',             // must NOT have 'guest'
                    'user-{params.id}'    // must have 'user-<id>' where <id> is the route param
                ]
            }
        },
        handler: function (request, h) {

            return { user: request.auth.credentials.user };
        }
    }
});
```

When multiple scopes are listed in the array, **all** of them must be satisfied (logical AND). To express OR logic, use multiple `access` entries:

```javascript
auth: {
    access: [
        { scope: ['admin'] },
        { scope: ['user-{params.id}'] }
    ]
}
```

This grants access if the credential has `admin` OR the matching `user-{params.id}` scope.


### Entity Access Control


The `entity` property in a route's `auth.access` config restricts which type of credential can access the route:

| Value    | Requirement                                              |
| -------- | -------------------------------------------------------- |
| `'user'` | `credentials.user` must be set                           |
| `'app'`  | `credentials.app` must be set                            |
| `'any'`  | Either `credentials.user` or `credentials.app` (default) |

```javascript
server.route({
    method: 'POST',
    path: '/app/webhook',
    options: {
        auth: {
            strategy: 'default',
            access: {
                entity: 'app',
                scope: ['webhook:send']
            }
        },
        handler: function (request, h) {

            return { received: true };
        }
    }
});
```


### `server.auth.lookup(route)`


Returns the authentication configuration for a route object. Useful for inspecting the resolved auth settings on a route, especially when defaults have been applied.

| Parameter | Type     | Description                            |
| --------- | -------- | -------------------------------------- |
| `route`   | `object` | A route object (e.g., `request.route`) |

Returns: the auth config object for the route, or `null` if the route has no authentication.

```javascript
server.route({
    method: 'GET',
    path: '/info',
    options: {
        auth: false,
        handler: function (request, h) {

            // Inspect auth config on a different route
            const routes = request.server.table();
            for (const route of routes) {
                const auth = request.server.auth.lookup(route);
                console.log(route.path, auth);
            }

            return { ok: true };
        }
    }
});
```


### `await server.auth.test(strategy, request)`


Tests a request against an authentication strategy without considering route config.

| Parameter  | Type      | Description        |
| ---------- | --------- | ------------------ |
| `strategy` | `string`  | Strategy name      |
| `request`  | `Request` | The request object |

Returns: `{ credentials, artifacts }` if successful. Throws on failure.

**Limitations:**
- Does not consider route authentication configuration.
- Does not perform payload authentication.
- Does not verify scope, entity, or other route properties.

```javascript
server.route({
    method: 'GET',
    path: '/check',
    options: {
        auth: false,    // no auth on this route
        handler: async function (request, h) {

            try {
                const { credentials, artifacts } = await request.server.auth.test('user-jwt', request);
                return { authenticated: true, user: credentials.user };
            }
            catch (err) {
                return { authenticated: false };
            }
        }
    }
});
```


### `await server.auth.verify(request)`


Verifies that a request's existing authentication credentials are still valid. Calls the scheme's `verify()` method.

| Parameter | Type      | Description                                        |
| --------- | --------- | -------------------------------------------------- |
| `request` | `Request` | The request object (must already be authenticated) |

Returns: nothing if verification succeeds. Throws on failure.

**Limitations:**
- Only uses `request.auth` (credentials and artifacts) -- does not re-examine the original request.
- Does not perform payload authentication.
- Does not verify scope, entity, or other route properties.
- Requires the scheme to implement a `verify()` method.

```javascript
server.route({
    method: 'GET',
    path: '/sensitive',
    handler: async function (request, h) {

        // Re-verify credentials are still valid before sensitive operation
        try {
            await request.server.auth.verify(request);
            return performSensitiveAction();
        }
        catch (err) {
            return { status: false, message: 'Credentials no longer valid' };
        }
    }
});
```


### Complete Example: Custom Auth Scheme


```javascript
const Hapi = require('@hapi/hapi');
const Boom = require('@hapi/boom');

// 1. Define the scheme factory
const apiKeyScheme = function (server, options) {

    const validateKey = async (key) => {

        const record = await options.lookup(key);
        if (!record || record.expired) {
            return null;
        }

        return record;
    };

    return {
        // Expose utility via server.auth.api
        api: {
            rotateKey: async (oldKey) => {

                return options.rotate(oldKey);
            }
        },

        // Required: main authentication
        authenticate: async function (request, h) {

            const apiKey = request.headers['x-api-key'];
            if (!apiKey) {
                throw Boom.unauthorized(null, 'api-key');
            }

            const record = await validateKey(apiKey);
            if (!record) {
                throw Boom.unauthorized('Invalid API key');
            }

            return h.authenticated({
                credentials: {
                    user: record.user,
                    scope: record.scopes
                },
                artifacts: {
                    keyId: record.id,
                    issuedAt: record.created
                }
            });
        },

        // Optional: verify credentials are still valid
        verify: async function (auth) {

            const record = await options.lookup(auth.artifacts.keyId);
            if (!record || record.revoked) {
                throw Boom.unauthorized('API key revoked');
            }
        },

        // Optional: add headers to response
        response: function (request, h) {

            const remaining = request.auth.artifacts.rateLimit;
            if (remaining !== undefined) {
                request.response.header('X-Rate-Limit-Remaining', remaining);
            }

            return h.continue;
        },

        // Scheme options
        options: {
            payload: false  // do not require payload auth
        }
    };
};

// 2. Wire it up
const init = async () => {

    const server = Hapi.server({ port: 3000 });

    // Register the scheme
    server.auth.scheme('api-key', apiKeyScheme);

    // Create strategies from the scheme
    server.auth.strategy('internal-api', 'api-key', {
        lookup: async (key) => db.apiKeys.findOne({ key }),
        rotate: async (oldKey) => db.apiKeys.rotate(oldKey)
    });

    server.auth.strategy('partner-api', 'api-key', {
        lookup: async (key) => db.partnerKeys.findOne({ key }),
        rotate: async (oldKey) => db.partnerKeys.rotate(oldKey)
    });

    // Set default
    server.auth.default('internal-api');

    // Route using default auth
    server.route({
        method: 'GET',
        path: '/data',
        handler: (request, h) => {

            return { user: request.auth.credentials.user };
        }
    });

    // Route with specific strategy
    server.route({
        method: 'GET',
        path: '/partner/data',
        options: {
            auth: {
                strategy: 'partner-api',
                scope: ['read:data']
            },
            handler: (request, h) => {

                return { partner: true };
            }
        }
    });

    // Route with multiple strategies
    server.route({
        method: 'GET',
        path: '/flexible',
        options: {
            auth: {
                strategies: ['internal-api', 'partner-api'],
                mode: 'optional'
            },
            handler: (request, h) => {

                if (request.auth.isAuthenticated) {
                    return { user: request.auth.credentials.user };
                }

                return { anonymous: true };
            }
        }
    });

    // Route with no auth
    server.route({
        method: 'GET',
        path: '/public',
        options: {
            auth: false,
            handler: (request, h) => {

                return { public: true };
            }
        }
    });

    // Access scheme API
    const newKey = await server.auth.api['internal-api'].rotateKey('old-key-value');

    await server.start();
    console.log('Server running on %s', server.info.uri);
};

init();
```


### Common Gotchas


1. **Scheme before strategy:** `server.auth.scheme()` must be called before `server.auth.strategy()` that references it. Order matters.

2. **Strategy before default:** `server.auth.strategy()` must be called before `server.auth.default()` references the strategy name.

3. **Default timing:** `server.auth.default()` applies to routes based on when `server.route()` is called, not when `server.auth.default()` is called. Routes without any auth config get the default at registration time.

4. **Error messages control strategy fallthrough:** `Boom.unauthorized(null, 'SchemeName')` lets the next strategy try. `Boom.unauthorized('message')` stops the chain. This is the most common mistake when implementing multi-strategy auth.

5. **`verify()` has no request access:** The `verify` method only receives `request.auth` (credentials + artifacts), not the full request. Design your credentials/artifacts to contain everything needed for re-verification.

6. **Payload auth must return `h.continue`:** The `payload()` and `response()` methods must return `h.continue` on success, not `h.authenticated()`.

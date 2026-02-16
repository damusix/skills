## @hapi/jwt Validate Function Reference


The `validate` function is the application-level callback in a JWT strategy. It runs after token decoding and verification succeed, giving you control over whether to accept the token and what credentials to expose to route handlers.

    server.auth.strategy('jwt', 'jwt', {
        keys: 'secret-with-at-least-32-characters!!',
        verify: {
            aud: 'urn:audience:test',
            iss: 'urn:issuer:test',
            sub: false
        },
        validate: (artifacts, request, h) => {

            const user = artifacts.decoded.payload.user;
            if (!user) {
                return { isValid: false };
            }

            return {
                isValid: true,
                credentials: { user, scope: artifacts.decoded.payload.scope }
            };
        }
    });


### Function Signature


    validate(artifacts, request, h)

| Parameter | Type | Description |
|---|---|---|
| `artifacts` | `object` | The decoded and verified token artifacts. See [Artifacts Structure](#artifacts-structure). |
| `request` | `object` | The hapi [request object](../lifecycle/request-object.md). Available for inspecting request context during validation. |
| `h` | `object` | The hapi [response toolkit](../lifecycle/response-toolkit.md). |


### Return Value


The `validate` function must return an object with the following properties. (`lib/index.js`)

| Property | Type | Required | Description |
|---|---|---|---|
| `isValid` | `boolean` | Yes | `true` if the token holder is authorized, `false` to reject. |
| `credentials` | `object` | No | Credentials object set on `request.auth.credentials`. Should contain user identity and authorization data (e.g., scope). |
| `response` | `object` | No | A takeover response (via `h.response()`). When provided, this response is used immediately, bypassing further processing. |

**Successful validation:**

    validate: (artifacts, request, h) => {

        return {
            isValid: true,
            credentials: {
                id: artifacts.decoded.payload.sub,
                email: artifacts.decoded.payload.email,
                scope: artifacts.decoded.payload.scope
            }
        };
    }

**Failed validation (returns 401):**

    validate: (artifacts, request, h) => {

        // Token is valid but user is not authorized
        return { isValid: false };
    }

**Custom takeover response:**

    validate: (artifacts, request, h) => {

        if (artifacts.decoded.payload.needsRefresh) {
            return {
                isValid: false,
                response: h.response({ requiresTokenRefresh: true }).code(401)
            };
        }

        return { isValid: true, credentials: { user: artifacts.decoded.payload.user } };
    }


### Artifacts Structure


The `artifacts` parameter passed to `validate` contains the full decoded token. (`lib/index.js`)

    {
        token: 'the.raw.jwt-string',
        decoded: {
            header: {
                alg: 'HS256',
                typ: 'JWT'
            },
            payload: {
                aud: 'urn:audience:test',
                iss: 'urn:issuer:test',
                sub: 'user-123',
                iat: 1609459200,
                exp: 1609462800,
                user: { name: 'John' },
                scope: ['admin', 'user']
            },
            signature: 'base64url-encoded-signature'
        }
    }

| Property | Type | Description |
|---|---|---|
| `artifacts.token` | `string` | The raw JWT string as extracted from the request. |
| `artifacts.decoded.header` | `object` | The JWT header containing `alg`, `typ`, and optionally `kid`. |
| `artifacts.decoded.payload` | `object` | The JWT payload with registered claims (`iss`, `sub`, `aud`, `exp`, `nbf`, `iat`) and any custom claims. |
| `artifacts.decoded.signature` | `string` | The base64url-encoded signature. |
| `artifacts.raw` | `object` | The raw (unparsed) header, payload, and signature strings as split from the token. |
| `artifacts.keys` | `object` | The key(s) used for signature verification. |


### Async Validation


The `validate` function can be `async` for database lookups, permission checks, or any I/O operation:

    validate: async (artifacts, request, h) => {

        const userId = artifacts.decoded.payload.sub;
        const user = await request.server.methods.getUser(userId);

        if (!user || user.banned) {
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
    }


### Using Credentials in Handlers


After successful validation, the credentials are accessible throughout the request lifecycle:

    server.route({
        method: 'GET',
        path: '/profile',
        options: {
            auth: 'my_jwt_strategy'
        },
        handler: (request, h) => {

            const userId = request.auth.credentials.id;
            const scope = request.auth.credentials.scope;

            return { userId, scope };
        }
    });

See [request object](../lifecycle/request-object.md) for the full `request.auth` structure.


### Scope-Based Authorization


JWT tokens commonly carry scope or role claims. Combine with hapi's built-in scope authorization on [route auth](../route/auth.md):

    // In validate, map token claims to credentials.scope
    validate: (artifacts, request, h) => {

        return {
            isValid: true,
            credentials: {
                user: artifacts.decoded.payload.sub,
                scope: artifacts.decoded.payload.scope   // e.g., ['admin', 'read:users']
            }
        };
    }

    // On the route, require specific scopes
    server.route({
        method: 'DELETE',
        path: '/users/{id}',
        options: {
            auth: {
                strategy: 'my_jwt_strategy',
                access: {
                    scope: ['admin']                     // requires 'admin' in credentials.scope
                }
            }
        },
        handler: deleteUserHandler
    });


### Cross-References


- [overview](overview.md) -- strategy registration and options
- [token API](token-api.md) -- generating tokens with claims used in validation
- [server auth](../server/auth.md) -- scheme/strategy/default model
- [route auth](../route/auth.md) -- per-route auth modes and scope requirements
- [request object](../lifecycle/request-object.md) -- accessing `request.auth.credentials`
- [response toolkit](../lifecycle/response-toolkit.md) -- building takeover responses in validate


### Gotchas


- **`isValid: false` without `response` returns a generic 401.** If you need a custom error message, throw a [Boom.unauthorized](../lifecycle/boom.md) error instead of returning `{ isValid: false }`.
- **`credentials` should contain `scope` for route-level authorization.** Hapi's route `access.scope` checks `request.auth.credentials.scope`. If you do not set it in `validate`, scope-based route restrictions will always fail.
- **Validate runs after verification.** By the time `validate` is called, the token signature and claims (exp, nbf, aud, iss, sub) have already been verified. You do not need to re-check expiration.
- **Throwing in validate.** If `validate` throws an error, hapi treats it as an internal server error (500), not a 401. Use `return { isValid: false }` for auth rejection, or throw `Boom.unauthorized()` for explicit 401.
- **The `request` parameter is partially built.** During authentication, the request has not yet passed through route validation or pre-handlers. `request.payload` may not be available if parsing has not completed.
- **`artifacts.decoded.payload` contains all claims.** Both registered JWT claims (iss, sub, aud, exp, nbf, iat) and your custom claims live in the same `payload` object. There is no separate namespace for custom data.

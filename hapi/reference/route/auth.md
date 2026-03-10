## Route Authentication (`route.options.auth`)


Controls authentication for the route. Value can be:

- `false` -- disable authentication (only meaningful when a default strategy is set).
- A string -- name of a strategy registered with `server.auth.strategy()`. Sets mode to `'required'`.
- An authentication configuration object (see below).

    // Disable auth
    server.route({ method: 'GET', path: '/public', options: { auth: false, handler: () => 'open' } });

    // Use a named strategy (mode defaults to 'required')
    server.route({ method: 'GET', path: '/profile', options: { auth: 'jwt', handler: () => 'ok' } });

    // Full auth config object
    server.route({
        method: 'GET',
        path: '/admin',
        options: {
            auth: {
                strategy: 'jwt',
                mode: 'required',
                access: {
                    scope: ['admin'],
                    entity: 'user'
                }
            },
            handler: (request, h) => request.auth.credentials
        }
    });

### Auth configuration object properties


| Property | Default | Description |
|----------|---------|-------------|
| `strategy` | server default | Single strategy name string. Cannot coexist with `strategies`. |
| `strategies` | server default | Array of strategy names tried in order. Cannot coexist with `strategy`. |
| `mode` | `'required'` | `'required'`, `'optional'`, or `'try'`. |
| `access` | none | Object or array of access rule objects. |
| `scope` | `false` | Shorthand -- same as `access: { scope: ... }`. |
| `entity` | `'any'` | Shorthand -- same as `access: { entity: ... }`. |
| `payload` | `false` | Payload authentication: `false`, `'required'`, or `'optional'`. |

### Auth modes


| Mode | Behavior |
|------|----------|
| `'required'` | Request must include valid credentials. Fails otherwise. |
| `'optional'` | Request must have valid credentials **or no credentials at all**. Invalid credentials fail. |
| `'try'` | Like `'optional'`, but invalid credentials do NOT fail the request. Error info is available in `request.auth`. |

    server.route({
        method: 'GET',
        path: '/maybe-auth',
        options: {
            auth: { strategy: 'session', mode: 'try' },
            handler: function (request, h) {

                if (request.auth.isAuthenticated) {
                    return `Hello ${request.auth.credentials.name}`;
                }

                return 'Hello stranger';
            }
        }
    });

### Access rules


The `access` property is an object or array of objects. Access is granted if **at least one** rule matches. Each rule must include at least one of `scope` or `entity`.

    auth: {
        strategy: 'jwt',
        access: [
            { scope: ['admin'] },                    // admin scope OR
            { scope: ['manager'], entity: 'user' }   // manager scope + user entity
        ]
    }

### Scope


Scope is a string or array of strings matched against `credentials.scope`. The credential must contain **at least one** of the listed scopes.

**Scope prefixes:**

| Prefix | Meaning | Example |
|--------|---------|---------|
| (none) | At least one of these must be present | `['read', 'write']` -- need `read` OR `write` |
| `+` | Required -- must be present | `'+admin'` -- must have `admin` |
| `!` | Forbidden -- must NOT be present | `'!guest'` -- must not have `guest` |

Combined example: `['!guest', '+authenticated', 'admin', 'superuser']` means:
- Must NOT have `guest`
- MUST have `authenticated`
- Must have `admin` OR `superuser`

### Dynamic scope


Scope strings can reference request properties using `{property}` syntax:

| Placeholder | Source |
|-------------|--------|
| `{params.id}` | `request.params` |
| `{query.team}` | `request.query` |
| `{payload.org}` | `request.payload` |
| `{credentials.userId}` | `request.auth.credentials` |

    server.route({
        method: 'PUT',
        path: '/user/{id}',
        options: {
            auth: {
                strategy: 'jwt',
                access: { scope: ['user-{params.id}'] }
            },
            handler: (request, h) => 'ok'
        }
    });

A request to `PUT /user/42` requires the credential to have `user-42` in its scope array.

### Modifying Scope Before Authorization


Route scope checking runs during the authorization step. The `onCredentials` extension fires between authentication and authorization, making it the right place to modify credential scope dynamically:

    server.ext('onCredentials', async (request, h) => {

        const userId = request.auth.credentials.userId;
        const permissions = await getPermissionsFromDb(userId);

        request.auth.credentials.scope = permissions;

        return h.continue;
    });

Use this when scope cannot be determined during authentication alone (e.g., permissions stored separately from identity).


### Dynamic Authorization


Route-level scope config is **static** -- compiled once at route registration and fixed for the lifetime of the route. For authorization that depends on request data or database lookups, handle it in `onPostAuth` or a route `pre` handler.

**Global approach (`onPostAuth`):**

    server.ext('onPostAuth', async (request, h) => {

        const resource = await db.getResource(request.params.id);
        const requiredScope = resource.isPublished ? 'read' : 'draft:read';

        if (!request.auth.credentials.scope?.includes(requiredScope)) {
            throw Boom.forbidden(`Requires scope: ${requiredScope}`);
        }

        return h.continue;
    });

**Per-route approach (`pre` handler):**

    server.route({
        method: 'PUT',
        path: '/resource/{id}',
        options: {
            auth: { strategy: 'jwt', mode: 'required' },
            pre: [
                {
                    assign: 'authorize',
                    method: async (request, h) => {

                        const resource = await db.getResource(request.params.id);
                        const needed = resource.ownerId === request.auth.credentials.userId
                            ? 'write:own'
                            : 'write:all';

                        if (!request.auth.credentials.scope?.includes(needed)) {
                            throw Boom.forbidden('Insufficient scope');
                        }

                        return resource;
                    }
                }
            ],
            handler: (request, h) => request.pre.authorize
        }
    });

Use `onPostAuth` for cross-cutting rules. Use `pre` for route-specific authorization that needs resource data.


### Built-in Access Check


To check a request against the route's static scope and entity config:

    const hasAccess = request.route.auth.access(request);  // boolean

This runs the full scope and entity validation against the route's compiled auth config. It cannot be used with dynamic scope rules -- for those, see **Dynamic Authorization** above.


### Entity


Controls whether the credential must represent a user or an application:

| Value | Meaning |
|-------|---------|
| `'any'` | No restriction (default). |
| `'user'` | `credentials` must have a `user` attribute present. |
| `'app'` | `credentials` must NOT have a `user` attribute. |

### Payload authentication


For schemes that support payload authentication (e.g., Hawk):

| Value | Behavior |
|-------|----------|
| `false` | No payload authentication (default). |
| `'required'` | Payload authentication required. |
| `'optional'` | Only performed when the client includes payload auth information (e.g., Hawk `hash`). |

Cannot be set to a value other than `'required'` when the scheme's `options.payload` is `true`.

### TypeScript


The auth types support augmentation for type-safe strategy and scope values:

    declare module '@hapi/hapi' {
        interface RouteOptionTypes {
            Strategy: 'jwt' | 'session';
            Scope: 'admin' | 'user' | 'guest';
        }
    }

### Gotchas


- `strategy` and `strategies` are mutually exclusive.
- When using `mode: 'try'`, always check `request.auth.isAuthenticated` before trusting credentials.
- Dynamic scope resolution happens after payload processing, so `{payload.*}` references work.
- The `access` array uses OR logic between rules, but within a single rule, `scope` and `entity` are AND-ed.

### See Also

- [server auth](../server/auth.md) -- scheme, strategy, and default registration
- [@hapi/jwt](../jwt-auth/overview.md) -- JWT authentication plugin with built-in token extraction, signature verification, and claim validation

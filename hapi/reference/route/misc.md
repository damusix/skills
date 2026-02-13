## Miscellaneous Route Options


### `route.options.app`


Default: `{}`.

Application-specific route configuration state. Free-form object for your application's use. Plugins should use `options.plugins[name]` instead.

    server.route({
        method: 'GET',
        path: '/admin',
        options: {
            app: { requiresFeatureFlag: 'admin-panel' },
            handler: (request, h) => {

                const flag = request.route.settings.app.requiresFeatureFlag;
                return `Flag: ${flag}`;
            }
        }
    });

---

### `route.options.bind`


Default: `null`.

Object passed as `this` to the handler and extension methods. Ignored for arrow functions (use `h.context` instead).

    server.route({
        method: 'GET',
        path: '/bound',
        options: {
            bind: { db: myDatabaseConnection },
            handler: function (request, h) {

                return this.db.query('SELECT 1');
            }
        }
    });

---

### `route.options.description`


Default: none.

Route description string for documentation generation.

    options: {
        description: 'Retrieve a user by ID'
    }

Not available as a server route default (`server.options.routes`).

---

### `route.options.ext`


Default: none.

Route-level request extension points. Keys are lifecycle event names (except `'onRequest'` which is not allowed). Values are the same as `server.ext()` event arguments.

    server.route({
        method: 'GET',
        path: '/data',
        options: {
            ext: {
                onPreAuth: {
                    method: function (request, h) {

                        request.app.startTime = Date.now();
                        return h.continue;
                    }
                },
                onPostHandler: {
                    method: function (request, h) {

                        const elapsed = Date.now() - request.app.startTime;
                        request.log(['perf'], { elapsed });
                        return h.continue;
                    }
                }
            },
            handler: () => 'ok'
        }
    });

Available extension points (in lifecycle order):
- `onPreAuth`
- `onCredentials`
- `onPostAuth`
- `onPreHandler`
- `onPostHandler`
- `onPreResponse`
- `onPostResponse`

Each value can be a single extension object or an array of them.

---

### `route.options.files`


Default: `{ relativeTo: '.' }`.

Controls file serving behavior:

| Property | Default | Description |
|----------|---------|-------------|
| `relativeTo` | `'.'` | Base directory for resolving relative file paths. |

    options: {
        files: { relativeTo: Path.join(__dirname, 'public') }
    }

---

### `route.options.id`


Default: none.

Unique route identifier string. Used with `server.lookup(id)` to retrieve the route.

    server.route({
        method: 'GET',
        path: '/user/{id}',
        options: {
            id: 'getUser',
            handler: () => 'ok'
        }
    });

    // Later:
    const route = server.lookup('getUser');

Cannot be assigned to routes registered with an array of methods.

---

### `route.options.isInternal`


Default: `false`.

When `true`, the route is only accessible via `server.inject()` with `allowInternals: true`. HTTP requests will receive a 404.

    server.route({
        method: 'GET',
        path: '/internal/health',
        options: {
            isInternal: true,
            handler: () => ({ status: 'ok' })
        }
    });

    // Access via inject only:
    const res = await server.inject({
        url: '/internal/health',
        allowInternals: true
    });

---

### `route.options.json`


Default: none.

Arguments passed to `JSON.stringify()` when serializing response objects:

| Property | Default | Description |
|----------|---------|-------------|
| `replacer` | none | Replacer function or array for `JSON.stringify()`. |
| `space` | none | Number of spaces for indentation. |
| `suffix` | none | String appended after JSON serialization. |
| `escape` | `false` | If `true`, calls `Hoek.jsonEscape()` on the JSON string. |

    options: {
        json: {
            space: 2,
            suffix: '\n',
            escape: true    // Escapes HTML characters in JSON
        }
    }

---

### `route.options.log`


Default: `{ collect: false }`.

| Property | Default | Description |
|----------|---------|-------------|
| `collect` | `false` | If `true`, request logs are collected in `request.logs`. |

    options: {
        log: { collect: true },
        handler: function (request, h) {

            request.log(['info'], 'Processing request');
            console.log(request.logs);    // Array of log entries
            return 'ok';
        }
    }

---

### `route.options.notes`


Default: none.

Route notes for documentation generation. String or array of strings.

    options: {
        notes: ['Returns user profile', 'Requires authentication']
    }

Not available as a server route default (`server.options.routes`).

---

### `route.options.plugins`


Default: `{}`.

Plugin-specific configuration. Each key is a plugin name with its configuration as the value.

    options: {
        plugins: {
            'hapi-rate-limit': { limit: 100 },
            'hapi-swagger': { deprecated: true }
        }
    }

---

### `route.options.rules`


Default: none.

Custom rules object passed to each rules processor registered with `server.rules()`. Cannot coexist with the top-level `route.rules` property.

    // Register a rules processor
    server.rules((rules, info) => {

        return {
            auth: rules.auth,
            plugins: rules.plugins
        };
    });

    // Use rules in route
    server.route({
        method: 'GET',
        path: '/data',
        options: {
            rules: { auth: 'jwt', plugins: { rateLimit: true } },
            handler: () => 'ok'
        }
    });

---

### `route.options.state`


Default: `{ parse: true, failAction: 'error' }`.

HTTP cookie handling configuration:

| Property | Default | Description |
|----------|---------|-------------|
| `parse` | `true` | Parse incoming `Cookie` headers into `request.state`. |
| `failAction` | `'error'` | How to handle cookie parsing errors. Returns 400 on error. |

    options: {
        state: {
            parse: true,
            failAction: 'log'    // Log cookie errors instead of returning 400
        }
    }

---

### `route.options.tags`


Default: none.

Array of tag strings for documentation generation.

    options: {
        tags: ['api', 'user', 'public']
    }

Not available as a server route default (`server.options.routes`).

---

### `route.options.timeout`


Default: `{ server: false }`.

| Property | Default | Description |
|----------|---------|-------------|
| `server` | `false` | Response timeout in ms. Returns 503 if exceeded. `false` to disable. |
| `socket` | none (node default: 2 min) | Socket inactivity timeout. `false` to disable. |

    options: {
        timeout: {
            server: 30000,     // 30 second response timeout
            socket: 60000      // 60 second socket timeout
        }
    }

The `server` timeout covers the total time from receiving the request to sending the response. The `socket` timeout covers idle socket time (node's default is 2 minutes).

    // Long-running endpoint
    server.route({
        method: 'POST',
        path: '/export',
        options: {
            timeout: {
                server: 120000,     // 2 minutes for the server to respond
                socket: 130000      // Socket timeout must exceed server timeout
            },
            payload: {
                timeout: 60000      // Separate: time to receive the payload
            },
            handler: async (request, h) => {

                return await generateLargeExport();
            }
        }
    });

**Gotcha:** `timeout.server` is different from `payload.timeout`. The payload timeout controls how long the server waits to receive the body; the server timeout controls how long the handler has to produce a response.

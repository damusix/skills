## hapi Server Routing Reference


### server.route(route)


Adds one or more routes. Returns nothing.

**Route configuration object:**

| Property  | Required | Type                         | Description                                                                                                                         |
| --------- | -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `path`    | yes      | `string`                     | Absolute path starting with `'/'`. Supports path parameters.                                                                        |
| `method`  | yes      | `string \| string[]`         | HTTP method(s). Use `'*'` to match any method (lower priority than specific methods). Any method allowed except `'HEAD'`.           |
| `vhost`   | no       | `string \| string[]`         | Restrict route to matching Host header (hostname only, no port).                                                                    |
| `handler` | yes*     | `function(request, h)`       | Route handler. Required unless `handler` is set inside `options`.                                                                   |
| `options` | no       | `object \| function(server)` | Additional route options. If a function, receives the server and returns an object.                                                 |
| `rules`   | no       | `object`                     | Custom rules object passed to rules processors registered with `server.rules()`. Cannot be used if `options.rules` is also defined. |

*Handler can be in the top level or inside `options`, but must exist in one place.

**Basic examples:**

```js
    // Handler at top level
    server.route({ method: 'GET', path: '/status', handler: () => 'ok' });

    // Handler in options
    server.route({
        method: 'GET',
        path: '/user',
        options: {
            cache: { expiresIn: 5000 },
            handler: (request, h) => {

                return { name: 'John' };
            }
        }
    });

    // Array of routes
    server.route([
        { method: 'GET', path: '/a', handler: () => 'a' },
        { method: 'POST', path: '/b', handler: () => 'b' }
    ]);

    // Multiple methods
    server.route({ method: ['GET', 'POST'], path: '/both', handler: () => 'ok' });
```


### Path Parameters


Parameters are enclosed in `{}` and matched against request path segments.

| Syntax     | Name          | Behavior                                                   | Example Path       | Matches                                          |
| ---------- | ------------- | ---------------------------------------------------------- | ------------------ | ------------------------------------------------ |
| `{name}`   | Required      | Matches one segment exactly                                | `/book/{id}/cover` | `/book/123/cover` -> `params.id = '123'`         |
| `{name?}`  | Optional      | Matches one segment or empty                               | `/book/{id?}`      | `/book/` -> `params.id = ''`                     |
| `{name*}`  | Wildcard      | Matches any number of segments (greedy, last segment only) | `/files/{path*}`   | `/files/a/b/c` -> `params.path = 'a/b/c'`        |
| `{name*N}` | Multi-segment | Matches exactly N segments                                 | `/person/{name*2}` | `/person/john/doe` -> `params.name = 'john/doe'` |

**Rules and constraints:**
- Each path segment can only contain one named parameter.
- A parameter can cover the entire segment (`/{param}`) or part of it (`/file.{ext}`).
- Parameter names may only contain letters, numbers, and underscores. `/{file-name}` is **invalid**, `/{file_name}` is valid.
- Optional `?` suffix is only allowed at the end of the path or as part of a mixed segment like `/a{param?}/b`.
- Multi-segment `*N` must have N > 1. Unlimited `*` can only appear in the last path segment.

**Path matching priority (highest to lowest):**
1. String literals (no parameter)
2. Mixed parameters (`/a{p}b`)
3. Parameters (`/{p}`)
4. Wildcard (`/{p*}`)

Mixed parameters are slower because they require regex iteration instead of hash lookup.

**Catch-all route (custom 404):**

```js
    server.route({
        method: '*',
        path: '/{p*}',
        handler: (request, h) => {

            return h.response('Not Found').code(404);
        }
    });
```


### server.path(relativeTo)


Sets the path prefix for locating static resources (files, view templates) when relative paths starting with `'.'` are used.

```js
    exports.plugin = {
        name: 'example',
        register: function (server, options) {

            server.path(__dirname + '/../static');
            server.route({
                path: '/file',
                method: 'GET',
                handler: { file: './test.html' }  // Resolved relative to the set path
            });
        }
    };
```

**Gotchas:**
- When set inside a plugin, only applies to that plugin's resources.
- Only applies to routes added **after** the path is set.
- If not set, falls back to server default `routes.files.relativeTo`.


### server.table([host])


Returns a copy of the routing table.

| Parameter | Type                | Description                                           |
| --------- | ------------------- | ----------------------------------------------------- |
| `host`    | `string` (optional) | Filter routes by virtual host. Defaults to all hosts. |

**Return value:** Array of route objects, each with:
- `settings` -- route config with defaults applied
- `method` -- HTTP method (lower case)
- `path` -- route path

```js
    const table = server.table();
    console.log(table[0].method);   // 'get'
    console.log(table[0].path);     // '/example'
    console.log(table[0].settings); // full route config

    // Filter by vhost
    const apiRoutes = server.table('api.example.com');
```


### server.lookup(id)


Finds a route by its `id` option.

```js
    server.route({
        method: 'GET',
        path: '/',
        options: {
            id: 'root',
            handler: () => 'ok'
        }
    });

    const route = server.lookup('root');
    // Returns route information object, or null if not found
```


### server.match(method, path, [host])


Finds a route matching the given method and path.

| Parameter | Type                | Description                                    |
| --------- | ------------------- | ---------------------------------------------- |
| `method`  | `string`            | HTTP method (e.g., `'GET'`). Case-insensitive. |
| `path`    | `string`            | Request path (must start with `'/'`).          |
| `host`    | `string` (optional) | Hostname for vhost matching.                   |

```js
    const route = server.match('get', '/');
    // Returns route information object, or null if not found

    const vhostRoute = server.match('get', '/api', 'api.example.com');
```


### server.rules(processor, [options])


Defines a rules processor that converts custom route `rules` objects into standard route configuration.

| Parameter                  | Type                    | Description                                                       |
| -------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `processor`                | `function(rules, info)` | Receives custom rules and route info, returns route config object |
| `options.validate.schema`  | joi schema              | Validates the rules object                                        |
| `options.validate.options` | object                  | joi validation options. Defaults to `{ allowUnknown: true }`      |

The `info` argument contains: `method`, `path`, `vhost`.

**Only one rules processor per server/plugin realm.** Routes added after rules configuration do not receive the rules config. Plugin rules processors override parent realm processors when they overlap. The route's own config overrides rules processor output.

```js
    const processor = (rules, info) => {

        if (!rules) {
            return null;
        }

        const options = {};

        if (rules.auth) {
            options.auth = {
                strategy: rules.auth,
                validate: { entity: 'user' }
            };
        }

        if (rules.cacheTtl) {
            options.cache = { expiresIn: rules.cacheTtl };
        }

        return options;
    };

    server.rules(processor, {
        validate: {
            schema: Joi.object({
                auth: Joi.string(),
                cacheTtl: Joi.number()
            })
        }
    });

    server.route({
        method: 'GET',
        path: '/',
        rules: {
            auth: 'jwt',
            cacheTtl: 30000
        },
        options: {
            id: 'my-route'
        }
    });
```

## Route Configuration Overview


A route is registered via `server.route(route)` where `route` is a configuration object (or array of them).

### Minimal route structure


    server.route({
        method: 'GET',
        path: '/hello',
        handler: function (request, h) {

            return 'Hello!';
        }
    });

### Full route properties


| Property  | Required                  | Description                                                                                     |
| --------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `method`  | Yes                       | HTTP method string or array of strings. `'*'` matches any method.                               |
| `path`    | Yes                       | Absolute path starting with `/`. May contain parameters.                                        |
| `handler` | Yes (if not in `options`) | Lifecycle method or handler decoration object.                                                  |
| `options` | No                        | Route options object or `function(server)` returning one.                                       |
| `vhost`   | No                        | Domain string or array to limit route to matching `Host` header.                                |
| `rules`   | No                        | Custom rules object passed to `server.rules()` processors. Cannot coexist with `options.rules`. |

The handler can live at the top level or inside `options`:

    // Handler at top level
    server.route({ method: 'GET', path: '/a', handler: () => 'ok' });

    // Handler inside options
    server.route({
        method: 'GET',
        path: '/b',
        options: {
            cache: { expiresIn: 5000 },
            handler: (request, h) => ({ name: 'John' })
        }
    });

### Method values


- Any HTTP method string except `'HEAD'` (added automatically for GET routes).
- Case-insensitive: `'get'` and `'GET'` both work.
- Use `'*'` to match any method. A specific method match always takes priority over wildcard.
- Can be an array: `method: ['GET', 'POST']`.

### Path parameters


Parameters are enclosed in `{}` within the path. A path segment can contain one named parameter.

| Syntax     | Meaning                                              | Example path       | Matches                |
| ---------- | ---------------------------------------------------- | ------------------ | ---------------------- |
| `{name}`   | Required param                                       | `/user/{id}`       | `/user/42`             |
| `{name?}`  | Optional param (end of path or partial segment)      | `/user/{id?}`      | `/user/` or `/user/42` |
| `{name*}`  | Wildcard (any number of segments, last segment only) | `/files/{path*}`   | `/files/a/b/c`         |
| `{name*2}` | Multi-segment (exactly N segments)                   | `/person/{name*2}` | `/person/john/doe`     |

Rules:
- Parameter names may only contain letters, numbers, and underscores. `{file-name}` is invalid; use `{file_name}`.
- A parameter can cover the entire segment (`/{param}`) or part of it (`/file.{ext}`).
- Optional `?` suffix only allowed at end of path or in a partial segment like `/a{p?}/b`.
- Wildcard `*` without a number only allowed in the last path segment.
- Multi-segment values are joined with `/` in `request.params` (e.g., `request.params.name` is `'john/doe'`).

    server.route({
        method: 'GET',
        path: '/{album}/{song?}',
        handler: function (request, h) {

            return 'You asked for ' +
                (request.params.song ? request.params.song + ' from ' : '') +
                request.params.album;
        }
    });

### Path matching order


Routes are matched deterministically (order of registration does not matter):

1. **String literals** (highest priority) -- `/users/list`
2. **Mixed parameters** -- `/users/{id}.json`
3. **Parameters** -- `/users/{id}`
4. **Wildcards** (lowest priority) -- `/users/{path*}`

Mixed parameters are slower because they require regex iteration at each routing node.

### Catch-all route


Override the default 404 response:

    server.route({
        method: '*',
        path: '/{p*}',
        handler: function (request, h) {

            return h.response('Not found').code(404);
        }
    });

### `options` as a function


The `options` value can be a function that receives the server and returns an options object. `this` is bound to the current realm's `bind` option.

    server.route({
        method: 'GET',
        path: '/dynamic',
        options: function (server) {

            return {
                handler: () => server.info.uri
            };
        }
    });

### Route defaults via `server.options.routes`


Set default options for all routes on a server:

    const server = Hapi.server({
        port: 3000,
        routes: {
            cors: true,
            timeout: { server: 10000 },
            validate: {
                failAction: async (request, h, err) => {

                    throw err;
                }
            }
        }
    });

Individual route settings override server defaults (they are not merged). Not all options are available as defaults -- `description`, `notes`, `tags` are per-route only.

### Gotchas


- The `options` object is **deeply cloned** (except `bind` which is shallow-copied). Do not put values that are unsafe for deep copy.
- Routes with an array of methods cannot have an `id` assigned.
- `vhost` matching uses only the hostname portion of the `Host` header (excluding port).

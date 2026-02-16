## File Handler (`handler: { file: ... }`)


The `file` handler type is registered by [@hapi/inert](overview.md) and generates a static file endpoint. It is a [registered handler type](../route/handler.md) — an object with a single `file` key whose value configures the file to serve.

    server.route({
        method: 'GET',
        path: '/favicon.ico',
        handler: {
            file: 'favicon.ico'
        }
    });


### Configuration


The `file` handler value can be:

1. **A string** — the file path (relative to `relativeTo` or absolute):

        handler: {
            file: 'index.html'
        }

2. **A function** — receives the `request` object, returns a path string or a configuration object:

        handler: {
            file: function (request) {

                return `pages/${request.params.lang}/index.html`;
            }
        }

3. **A configuration object** with the following options:

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string \| function` | (required) | File path string, or a function `(request) => path` returning a string. Relative paths resolve against the route `files.relativeTo` setting. |
| `confine` | `string \| boolean` | `true` | Restricts file serving to a directory. `true` resolves to `'.'` relative to `relativeTo`. A string sets a custom confine directory. `false` disables confinement entirely. When enabled, paths that escape the confine directory return 403. (lib/file.js:69-80) |
| `filename` | `string` | basename of `path` | Filename for the `Content-Disposition` header. Requires `mode` to be set — validation fails without it. (lib/file.js:37) |
| `mode` | `false \| 'attachment' \| 'inline'` | `false` | Controls the `Content-Disposition` header. `'attachment'` forces download. `'inline'` suggests in-browser display. `false` omits the header. |
| `lookupCompressed` | `boolean` | `false` | Look for pre-compressed file variants (e.g., `.gz`) matching the client's `Accept-Encoding`. |
| `lookupMap` | `object` | `{ gzip: '.gz' }` | Maps encoding names to file extensions for compressed file lookup. |
| `etagMethod` | `'hash' \| 'simple' \| false` | `'hash'` | ETag calculation strategy. `'hash'` = SHA1 of contents. `'simple'` = hex size + mtime. `false` = no ETag. |
| `start` | `number` | `0` | Byte offset to begin reading. |
| `end` | `number` | end of file | Byte offset to stop reading. Must be >= `start`. (lib/file.js:35) |


### Examples


**Forced download:**

    server.route({
        method: 'GET',
        path: '/download/{file}',
        handler: {
            file: {
                path: function (request) {

                    return `downloads/${request.params.file}`;
                },
                mode: 'attachment',
                confine: './downloads'
            }
        }
    });

**Pre-compressed assets:**

    server.route({
        method: 'GET',
        path: '/assets/{path*}',
        handler: {
            file: {
                path: function (request) {

                    return request.params.path;
                },
                lookupCompressed: true
            }
        }
    });

**Dynamic path via function:**

    handler: {
        file: function (request) {

            return `themes/theme-${request.query.theme || 'default'}.css`;
        }
    }

The `path` function must return a string. When used as the top-level `file` value (not inside a config object), it is wrapped internally as `{ path: fn, confine: '.' }`. (lib/file.js:43-44)


### Path Resolution


1. If `path` is absolute, it is used as-is.
2. If `path` is relative, it is resolved against `route.options.files.relativeTo` (which inherits from the server `routes.files.relativeTo` or the plugin [realm](../server/realm.md) setting).
3. The resolved path is then checked against the `confine` directory. If it escapes confinement, a 403 Forbidden response is returned.


### When to Use File Handler vs h.file()


| Scenario | Use |
|---|---|
| Fixed file per route, no response customization needed | `handler: { file: ... }` |
| Dynamic file selection with response customization (headers, status code, vary) | [`h.file()`](overview.md) in a standard handler |
| Conditional file serving based on auth or request state | [`h.file()`](overview.md) in a standard handler |
| Serving an entire directory tree | [Directory handler](directory-handler.md) |


### Gotchas


- **Handler objects must have exactly one key.** `{ file: ... }` cannot be combined with other handler types in the same route. See [handler decoration](../route/handler.md).
- **The `path` function receives `request`** but runs after validation. You can safely use `request.params`, `request.query`, etc.
- **No inline response customization.** Unlike `h.file()`, you cannot chain `.code()`, `.header()`, or `.type()` on a handler object. Use route-level `options.response` or lifecycle extensions for that.
- **`confine: true` is relative to `relativeTo`.** If `relativeTo` is not set, `confine` has no meaningful base directory. Always set `relativeTo`.
- **Path traversal.** Even with `confine`, always validate/sanitize user-supplied path segments. Do not blindly pass `request.params` into the `path` function without checking for `..` or absolute paths.
- **File path cannot end with `/`.** An assertion prevents string paths ending with a trailing slash. (lib/file.js:46)
- **`lookupCompressed` is silently disabled** when `start` or `end` options are set, or when server compression is disabled. (lib/file.js:144-146)

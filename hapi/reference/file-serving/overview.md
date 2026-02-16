## @hapi/inert — Static File Serving


@hapi/inert is a **hapi plugin** that adds static file and directory serving capabilities. Unlike [Boom](../lifecycle/boom.md) (a standalone utility), inert must be registered via `server.register()`. Once registered, it adds:

- **`h.file()`** — a [response toolkit](../lifecycle/response-toolkit.md) decoration for serving files from handlers
- **`handler: { file: ... }`** — a [registered handler type](../route/handler.md) for single-file routes
- **`handler: { directory: ... }`** — a registered handler type for directory serving

    const Hapi = require('@hapi/hapi');
    const Inert = require('@hapi/inert');

    const server = Hapi.server({
        port: 3000,
        routes: {
            files: {
                relativeTo: Path.join(__dirname, 'public')
            }
        }
    });

    await server.register(Inert);


### Registration


Register inert like any hapi plugin. Inert does **not** accept registration options -- it asserts `Object.keys(options).length === 0`. (lib/index.js:40)

    await server.register(require('@hapi/inert'));

Configuration is read from `server.settings.plugins.inert` (set at server creation time):

| Option | Type | Default | Description |
|---|---|---|---|
| `etagsCacheMaxSize` | `number` | `1000` | Maximum number of file ETag hash values stored in the in-memory cache. Set to `0` to disable ETag caching. |

    const server = Hapi.server({
        port: 3000,
        plugins: {
            inert: {
                etagsCacheMaxSize: 5000
            }
        }
    });

    await server.register(require('@hapi/inert'));


### The `relativeTo` Setting


Inert resolves relative file paths against the route's `files.relativeTo` setting. This is typically set at the server level so all routes share the same base directory:

    const server = Hapi.server({
        routes: {
            files: {
                relativeTo: Path.join(__dirname, 'public')
            }
        }
    });

It can also be set per-route or per-plugin via the [realm](../server/realm.md) (`server.realm.settings.files.relativeTo`). Plugin-scoped `relativeTo` is isolated from other plugins.


### h.file(path, [options])


A toolkit method added to [the response toolkit (`h`)](../lifecycle/response-toolkit.md) by inert registration. Transmits a file from the file system. Returns a standard response object that can be further customized with `.code()`, `.header()`, `.type()`, etc.

    server.route({
        method: 'GET',
        path: '/download',
        handler: (request, h) => {

            return h.file('report.pdf', { mode: 'attachment' });
        }
    });

**Parameters:**

- `path` — (required) relative or absolute file path string. Relative paths resolve against `relativeTo`.
- `options` — (optional) object:

| Option | Type | Default | Description |
|---|---|---|---|
| `confine` | `string \| boolean` | `true` | Serve file relative to this directory; returns 403 if path resolves outside. `true` uses the route `relativeTo`. `false` disables confinement. A string sets a custom confine directory. |
| `filename` | `string` | basename of `path` | Filename for the `Content-Disposition` header. Only relevant when `mode` is set. |
| `mode` | `false \| 'attachment' \| 'inline'` | `false` | Controls the `Content-Disposition` header. `false` omits it. `'attachment'` forces download. `'inline'` displays in browser. |
| `lookupCompressed` | `boolean` | `false` | If `true`, looks for pre-compressed file variants (e.g., `file.js.gz`) based on the client's `Accept-Encoding`. |
| `lookupMap` | `object` | `{ gzip: '.gz' }` | Maps content encoding names to file extensions for compressed lookup. |
| `etagMethod` | `'hash' \| 'simple' \| false` | `'hash'` | ETag calculation method. `'hash'` computes SHA1 of file contents. `'simple'` uses hex-encoded size and modification date. `false` disables ETags. |
| `start` | `number` | `0` | Byte offset to begin reading from. |
| `end` | `number` | end of file | Byte offset to stop reading at. |

**Return value:** A standard hapi response object. The response flows through the normal [response marshal pipeline](../lifecycle/response-marshal.md). Unlike handler return values, `h.file()` does not follow flow control rules (cannot use `h.continue`).

**Dynamic file selection:**

    server.route({
        method: 'GET',
        path: '/file',
        handler: (request, h) => {

            let path = 'plain.txt';
            if (request.headers['x-magic'] === 'sekret') {
                path = 'awesome.png';
            }

            return h.file(path).vary('x-magic');
        }
    });

**Custom 404 page via onPreResponse:**

    server.ext('onPreResponse', (request, h) => {

        const response = request.response;
        if (response.isBoom && response.output.statusCode === 404) {
            return h.file('404.html').code(404);
        }

        return h.continue;
    });

See [boom errors](../lifecycle/boom.md) for error handling patterns, [response toolkit](../lifecycle/response-toolkit.md) for other toolkit methods, and [mimos](../server/mimos.md) for MIME type configuration that controls content-type detection on file responses.


### Gotchas


- **Must register before use.** Calling `h.file()` or using `handler: { file: ... }` without registering inert throws a runtime error. Unlike [Boom](../lifecycle/boom.md), inert is not a standalone import.
- **`confine` defaults to `true`.** Paths that resolve outside the `relativeTo` directory return 403 Forbidden. This is a security feature — disable only when you control all possible path inputs.
- **`relativeTo` must be absolute.** Using a relative `relativeTo` path causes unpredictable resolution. Always use `Path.join(__dirname, ...)` or `Path.resolve()`.
- **`etagMethod: 'hash'` reads the entire file** to compute the SHA1 digest. For very large files, use `'simple'` (size + mtime) to avoid the read overhead.
- **`lookupCompressed` requires pre-built files.** Inert does not compress files on the fly. You must create `.gz` (or other) variants yourself (e.g., during build). If the compressed variant is not found, the original is served.
- **`h.file()` returns a response object,** so it can be chained with `.code()`, `.header()`, `.type()`, `.vary()`, etc. This is unlike handler type objects (`handler: { file: ... }`) where you cannot customize the response inline.
- **`start`/`end` are not the same as HTTP Range requests.** These options define a fixed byte range at the route level. HTTP Range headers are handled separately by hapi's [response marshal pipeline](../lifecycle/response-marshal.md).

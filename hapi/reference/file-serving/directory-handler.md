## Directory Handler (`handler: { directory: ... }`)


The `directory` handler type is registered by [@hapi/inert](overview.md) and serves files from a directory tree. Routes using a directory handler **must** include a catch-all path parameter (e.g., `{param*}`).

    server.route({
        method: 'GET',
        path: '/static/{path*}',
        handler: {
            directory: {
                path: '.',
                redirectToSlash: true,
                index: true
            }
        }
    });


### Configuration


| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string \| string[] \| function` | (required) | The directory root path(s). Can be a single string, an array of strings (tried in order until a file is found), or a function `(request) => path \| path[]`. Relative paths resolve against `files.relativeTo`. |
| `index` | `boolean \| string \| string[]` | `true` | Controls index file lookup when a directory is requested. `true` looks for `index.html`. A string or array specifies custom index filenames. `false` disables index file serving. |
| `listing` | `boolean` | `false` | When `true`, generates an HTML directory listing if no index file is found. |
| `showHidden` | `boolean` | `false` | When `true`, hidden files (dotfiles) are included in listings and can be served. |
| `redirectToSlash` | `boolean` | `true` | When `true`, requests for a directory path without a trailing slash are redirected (302) to the same path with a trailing slash. Internally defaults to `true` when not explicitly set. (lib/directory.js:129) |
| `lookupCompressed` | `boolean` | `false` | Look for pre-compressed file variants (e.g., `.gz`) matching the client's `Accept-Encoding`. |
| `lookupMap` | `object` | `{ gzip: '.gz' }` | Maps encoding names to file extensions for compressed file lookup. |
| `etagMethod` | `'hash' \| 'simple' \| false` | `'hash'` | ETag calculation method. `'hash'` = SHA1. `'simple'` = size + mtime. `false` = disabled. |
| `defaultExtension` | `string` | none | Extension appended to the requested file path when the original file is not found. For example, `'html'` causes a request for `/page` to try `/page.html`. |


### Path Resolution


1. The catch-all parameter value (e.g., `request.params.path`) is appended to the `path` root.
2. If `path` is an array, each root is tried in order until a matching file is found.
3. Relative roots resolve against `route.options.files.relativeTo` (see [overview](overview.md)).
4. If the resolved path points to a directory:
    - `index` filenames are tried.
    - If no index is found and `listing` is `true`, a directory listing is returned.
    - If no index is found and `listing` is `false`, a 403 Forbidden is returned.


### Examples


**Full static site setup:**

    const Path = require('path');
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

    server.route({
        method: 'GET',
        path: '/{param*}',
        handler: {
            directory: {
                path: '.',
                redirectToSlash: true,
                index: true
            }
        }
    });

**Multiple root directories (fallback chain):**

    server.route({
        method: 'GET',
        path: '/assets/{path*}',
        handler: {
            directory: {
                path: [
                    './custom-theme',
                    './default-theme'
                ]
            }
        }
    });

Files are looked up in `custom-theme` first. If not found, `default-theme` is checked.

**Dynamic root via function:**

    server.route({
        method: 'GET',
        path: '/themes/{path*}',
        handler: {
            directory: {
                path: function (request) {

                    const theme = request.query.theme || 'default';
                    return `./themes/${theme}`;
                }
            }
        }
    });

**Directory listing enabled:**

    server.route({
        method: 'GET',
        path: '/files/{path*}',
        handler: {
            directory: {
                path: './uploads',
                listing: true,
                showHidden: false,
                index: false
            }
        }
    });

**Clean URLs with defaultExtension:**

    server.route({
        method: 'GET',
        path: '/docs/{path*}',
        handler: {
            directory: {
                path: './docs',
                defaultExtension: 'html',
                index: true
            }
        }
    });

Requesting `/docs/getting-started` serves `./docs/getting-started.html` if the bare path is not found.


### When to Use Directory Handler vs File Handler


| Scenario | Use |
|---|---|
| Serve an entire directory tree (SPA, static site, assets) | Directory handler |
| Serve a single specific file per route | [File handler](file-handler.md) |
| Dynamic per-request file selection with response customization | [`h.file()`](overview.md) |


### Gotchas


- **Catch-all parameter is required.** The route path must contain a multi-segment parameter like `{param*}` or `{path*}`. Without it, inert cannot resolve the requested file within the directory. A route like `path: '/static'` without a parameter will not work.
- **`listing: false` + no index = 403.** When a directory is requested, no index file is found, and `listing` is disabled, the response is 403 Forbidden (not 404).
- **`redirectToSlash` sends a 302.** Requesting `/static/css` when `css` is a directory results in a 302 redirect to `/static/css/`. This adds an extra round trip. Consider whether your routing structure requires it.
- **`showHidden: false` is the default.** Dotfiles like `.env`, `.gitignore`, or `.htaccess` are not served or listed by default. This is a security feature — enable `showHidden` only for trusted content.
- **`path` array order matters.** The first directory containing a matching file wins. Later directories are only checked if the file is not found in earlier ones.
- **The directory handler does not support inline response customization.** You cannot chain `.code()` or `.header()`. Use lifecycle extensions (e.g., `onPreResponse`) to modify directory handler responses. See [response marshal pipeline](../lifecycle/response-marshal.md).
- **`defaultExtension` does not override existing files.** If both `page` and `page.html` exist, requesting `/page` serves `page` directly. The extension is only appended when the original path is not found.
- **Security: always set `relativeTo` to an absolute path.** Without it, relative `path` values resolve against the process working directory, which is fragile and potentially dangerous.
- **Plugin-scoped `relativeTo`.** When inert routes are defined inside a [plugin](../plugins/overview.md), the plugin's [realm](../server/realm.md) `settings.files.relativeTo` is used. Set it via server options at registration or `server.path()` inside the plugin.

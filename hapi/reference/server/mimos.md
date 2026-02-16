## @hapi/mimos MIME Database Reference


Mimos is a MIME type database utility -- **not a plugin**. It wraps the `mime-db` database and provides file extension and content-type lookups. Hapi uses mimos internally to auto-detect content types for file responses (via [@hapi/inert](../file-serving/overview.md)). The server exposes its mimos instance at `server.mime`.

    const Mimos = require('@hapi/mimos');
    const mimos = new Mimos.Mimos();

    const mime = mimos.path('/static/app.js');
    // { source: 'iana', charset: 'UTF-8', compressible: true, extensions: ['js'], type: 'application/javascript' }

Mimos does **not** use `server.register()`. It is a standalone utility. Hapi creates an instance automatically from `server.options.mime` and exposes it as `server.mime`.


### Constructor


**`new Mimos.Mimos([options])`** -- creates a new Mimos instance with an optional override map.

    const mimos = new Mimos.Mimos({
        override: {
            'node/module': {
                source: 'iana',
                compressible: true,
                extensions: ['node', 'module', 'npm'],
                type: 'node/module'
            }
        }
    });

| Option | Type | Default | Description |
|---|---|---|---|
| `override` | `object` | `{}` | An object hash merged into the built-in `mime-db` database. Each key is a lower-cased MIME type string. Each value is a MIME definition object. |

**Override value properties:**

| Property | Type | Default | Description |
|---|---|---|---|
| `source` | `string` | -- | Source of the MIME type (e.g., `'iana'`, `'apache'`, `'nginx'`). |
| `compressible` | `boolean` | -- | Whether the MIME type is compressible. |
| `extensions` | `string[]` | -- | File extensions associated with this MIME type (without dots). |
| `charset` | `string` | -- | Default charset for this MIME type (e.g., `'UTF-8'`). |
| `type` | `string` | the key | The `type` value returned in result objects. Use this to alias one MIME type to another. |
| `predicate` | `function` | -- | A function with signature `function(mime)` executed when this MIME type is looked up. Allows dynamic customization of the returned MIME object. Must return the `mime` object. |


### API Methods


**`mimos.path(path)`** -- looks up a MIME type by file path extension. Returns a MIME object, or an empty object `{}` if no match is found.

    const mimos = new Mimos.Mimos();

    mimos.path('/static/public/app.js');
    // { source: 'iana', charset: 'UTF-8', compressible: true, extensions: ['js'], type: 'application/javascript' }

    mimos.path('report.pdf');
    // { source: 'iana', compressible: false, extensions: ['pdf'], type: 'application/pdf' }

    mimos.path('file.unknown');
    // {}

**`mimos.type(type)`** -- looks up a MIME type by content-type string. Returns a MIME object, or an empty object `{}` if no match is found.

    const mimos = new Mimos.Mimos();

    mimos.type('text/plain');
    // { source: 'iana', compressible: true, extensions: ['txt', 'text', 'conf', 'def', 'list', 'log', 'in', 'ini'], type: 'text/plain' }

    mimos.type('application/octet-stream');
    // { source: 'iana', compressible: false, extensions: ['bin', 'dms', 'lrf', 'mar', 'so', 'dist', ...], type: 'application/octet-stream' }


### MIME Object Shape


Every MIME lookup result has this general shape:

    {
        source: 'iana',
        compressible: true,
        charset: 'UTF-8',
        extensions: ['js'],
        type: 'application/javascript'
    }

| Property | Type | Description |
|---|---|---|
| `source` | `string` | Origin of the MIME type definition (`'iana'`, `'apache'`, `'nginx'`). |
| `compressible` | `boolean` | Whether the content is compressible. Used by hapi for content encoding decisions. |
| `charset` | `string` | Default character set. When present, hapi appends it to the `Content-Type` header (e.g., `text/html; charset=utf-8`). |
| `extensions` | `string[]` | Associated file extensions. Used by `mimos.path()` for reverse lookups. |
| `type` | `string` | The canonical MIME type string. |


### Integration with Hapi Server


Hapi creates a mimos instance during server construction from `server.options.mime` and exposes it as `server.mime`. This is the same instance used internally by [@hapi/inert](../file-serving/overview.md) for auto content-type detection on file responses.

**Configuring via server options:**

    const server = Hapi.server({
        port: 3000,
        mime: {
            override: {
                'application/javascript': {
                    source: 'iana',
                    charset: 'UTF-8',
                    compressible: true,
                    extensions: ['js', 'javascript'],
                    type: 'text/javascript'
                },
                'node/module': {
                    source: 'iana',
                    compressible: true,
                    extensions: ['node', 'module', 'npm'],
                    type: 'node/module'
                }
            }
        }
    });

**Using `server.mime` at runtime:**

    // Inside a plugin or route handler
    const mime = server.mime.path('/uploads/data.csv');
    // { source: 'iana', compressible: true, extensions: ['csv'], type: 'text/csv' }

    const type = server.mime.type('image/png');
    // { source: 'iana', compressible: false, extensions: ['png'], type: 'image/png' }


### Override Examples


**Add a custom MIME type:**

    const server = Hapi.server({
        mime: {
            override: {
                'application/vnd.myapp+json': {
                    source: 'iana',
                    compressible: true,
                    charset: 'UTF-8',
                    extensions: ['myapp'],
                    type: 'application/vnd.myapp+json'
                }
            }
        }
    });

    server.mime.path('config.myapp');
    // { source: 'iana', compressible: true, charset: 'UTF-8', extensions: ['myapp'], type: 'application/vnd.myapp+json' }

**Alias one MIME type to another using `type`:**

    const server = Hapi.server({
        mime: {
            override: {
                'application/javascript': {
                    source: 'iana',
                    charset: 'UTF-8',
                    compressible: true,
                    extensions: ['js', 'javascript'],
                    type: 'text/javascript'       // lookups for application/javascript return type: 'text/javascript'
                }
            }
        }
    });

**Dynamic customization with `predicate`:**

    const server = Hapi.server({
        mime: {
            override: {
                'text/html': {
                    predicate: function (mime) {

                        mime.charset = 'UTF-8';
                        return mime;
                    }
                }
            }
        }
    });

    // Every lookup for text/html now includes charset: 'UTF-8'


### Gotchas


- **Mimos is not a plugin.** Do not use `server.register()`. It is configured via `server.options.mime` and accessed via `server.mime`.
- **Override keys must be lower-cased.** MIME type keys like `'Application/JSON'` will not match. Always use `'application/json'`.
- **`predicate` must return the mime object.** If the predicate function does not return `mime`, the lookup result will be `undefined`.
- **Overrides merge, they do not replace.** When you override an existing MIME type, the override values are merged into the existing entry. Properties you do not specify retain their original `mime-db` values.
- **`type` aliasing affects content-type headers.** When you set `type: 'text/javascript'` on an `application/javascript` override, inert file responses for `.js` files will use the aliased type in the `Content-Type` header.
- **Empty object for unknown types.** Both `mimos.path()` and `mimos.type()` return `{}` (not `null` or `undefined`) when no match is found. Check with `Object.keys(result).length` or test for `result.type`.
- **`server.mime` is shared.** All plugins and routes on the same server share the same mimos instance. MIME overrides configured at server creation affect all file-serving routes.
- **Extensions are not dot-prefixed.** Use `['js']` not `['.js']` in the `extensions` array.

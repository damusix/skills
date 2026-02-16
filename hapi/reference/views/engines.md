## Template Engine Interface


Vision supports any template engine that exposes a `compile()` function. Engines are configured in the `engines` option of `server.views()`. See [overview](overview.md) for full registration details.


### Engine Configuration


Each key in the `engines` object maps a file extension to an engine. The value can be a module directly (if it exports `compile`) or a configuration object:

    // Module shorthand -- module must export compile()
    server.views({
        engines: {
            html: require('handlebars')
        },
        path: 'templates'
    });

    // Object form with options
    server.views({
        engines: {
            html: {
                module: require('handlebars'),
                compileMode: 'sync',
                isCached: true
            }
        },
        path: 'templates'
    });

| Option | Type | Default | Description |
|---|---|---|---|
| `module` | `object` | -- | The engine module. Required when using object form. Must expose a `compile()` method. |
| `compile` | `function` | -- | Alternative to `module` -- provide the compile function directly. |
| `compileMode` | `string` | `'sync'` | `'sync'` or `'async'`. Determines how `compile()` is called. |
| `isCached` | `boolean` | manager setting | Override the manager-level `isCached` per engine. |
| `path` | `string \| string[]` | manager setting | Override the template lookup path for this engine. |
| `relativeTo` | `string` | manager setting | Override the base path for this engine. |
| `compileOptions` | `object` | manager setting | Override compile options for this engine. |
| `runtimeOptions` | `object` | manager setting | Override runtime options for this engine. |
| `layoutPath` | `string` | manager setting | Override layout path for this engine. |
| `layout` | `boolean \| string` | manager setting | Override layout setting for this engine. |
| `layoutKeyword` | `string` | manager setting | Override layout keyword for this engine. |
| `encoding` | `string` | manager setting | Override file encoding for this engine. |
| `allowAbsolutePath` | `boolean` | manager setting | Override absolute path permission for this engine. |
| `allowInsecureAccess` | `boolean` | manager setting | Override insecure access permission for this engine. |
| `contentType` | `string` | manager setting | Override content type for this engine. |
| `partialsPath` | `string \| string[]` | manager setting | Override partials path for this engine. |
| `helpersPath` | `string \| string[]` | manager setting | Override helpers path for this engine. |

Engine-level settings override manager-level settings, giving per-extension control when multiple engines are configured.


### The `compile()` Function


The compile function is the core contract between vision and a template engine. Its signature depends on `compileMode`.

**Sync mode** (`compileMode: 'sync'`, the default):

    compile(template, compileOptions) → renderFunction

    // Where renderFunction has the signature:
    renderFunction(context, runtimeOptions) → string

The compile function receives the raw template string and returns a render function. The render function is called with context data and must return the rendered string.

    // Example: Handlebars (sync, native support)
    server.views({
        engines: { html: require('handlebars') },
        path: 'templates'
    });
    // Handlebars.compile(src, options) returns a function(context) → string

**Async mode** (`compileMode: 'async'`):

    compile(template, compileOptions, callback) → void

    // Where callback signature is:
    callback(err, renderFunction)

    // And renderFunction signature is:
    renderFunction(context, runtimeOptions, callback) → void

    // Where callback signature is:
    callback(err, rendered)

In async mode, both compilation and rendering use Node-style callbacks.

    // Example: async engine
    server.views({
        engines: {
            html: {
                compileMode: 'async',
                module: {
                    compile: function (template, options, callback) {

                        const render = function (context, runtimeOptions, next) {

                            const rendered = template.replace('{{message}}', context.message);
                            return next(null, rendered);
                        };

                        return callback(null, render);
                    }
                }
            }
        },
        path: 'templates'
    });


### Custom Engine Wrappers


Engines that do not natively match vision's `compile()` contract need a wrapper. This is common with modern engines.

**Eta example** (compile returns a function, but needs wrapping for render):

    server.views({
        engines: {
            eta: {
                compile: (src, options) => {

                    const compiled = Eta.compile(src, options);

                    return (context) => {

                        return Eta.render(compiled, context);
                    };
                }
            }
        },
        compileOptions: {
            autoEscape: true,
            tags: ['{{', '}}']
        },
        relativeTo: __dirname,
        path: 'templates'
    });

**Pug example** (native support -- `pug.compile()` returns a render function):

    const Pug = require('pug');

    server.views({
        engines: { pug: Pug },
        relativeTo: __dirname,
        path: 'templates',
        compileOptions: {
            basedir: Path.join(__dirname, 'templates')
        }
    });


### Template Caching


When `isCached` is `true` (default), vision caches the compiled render function keyed by template path. Subsequent renders skip disk reads and compilation entirely.

- Cache is per-engine, per-manager (scoped to the [realm](../server/realm.md)).
- Cache is in-memory only -- not connected to hapi's [server cache](../server/cache.md) system.
- Set `isCached: false` during development so template changes are picked up without restarting the server.
- In production, always leave caching enabled. Each uncached render reads from disk and recompiles.


### `compileOptions` vs `runtimeOptions`


| Property | When passed | To what |
|---|---|---|
| `compileOptions` | At compile time | The engine's `compile(template, compileOptions)` |
| `runtimeOptions` | At render time | The compiled `renderFunction(context, runtimeOptions)` |

Most engines only use `compileOptions`. `runtimeOptions` is useful for engines that support per-render configuration (e.g., data formatting options that vary by request).


### Multiple Engines


Vision supports multiple engines simultaneously. The file extension determines which engine is used:

    server.views({
        engines: {
            html: require('handlebars'),
            pug: require('pug'),
            ejs: require('ejs')
        },
        path: 'templates'
    });

    // Uses handlebars
    h.view('home.html', { title: 'Home' });

    // Uses pug
    h.view('profile.pug', { user });

    // With defaultExtension, the extension can be omitted
    server.views({
        engines: { html: require('handlebars') },
        path: 'templates',
        defaultExtension: 'html'
    });

    h.view('home', { title: 'Home' });  // Resolves to home.html


### Gotchas


- **Engine must export `compile`.** If the module does not have a `compile` property, vision throws at configuration time. Use the object form with a custom `compile` function for non-conforming engines.
- **`compileMode` must match the engine.** If set to `'sync'` but the engine's compile function expects a callback, rendering will fail silently or throw. If set to `'async'` but the engine is synchronous, the callback will never be called.
- **Partials and helpers are engine-specific.** Vision loads partials via `registerPartial()` (Handlebars convention) and helpers via `registerHelper()`. Engines that use different APIs for partials/helpers require manual registration before calling `server.views()`. See [context](context.md).
- **Engine-level options silently override manager options.** If you set `isCached: true` at the manager level but `isCached: false` on a specific engine, that engine's templates will not be cached. There is no warning.
- **Caching interacts with `compileOptions`.** If you change `compileOptions` after templates have been cached, the cached versions use the old options. Restart the server or disable caching to pick up changes.
- **`runtimeOptions` is rarely needed.** Most engines ignore the second argument to the render function. Only use it if your engine explicitly supports per-render options.

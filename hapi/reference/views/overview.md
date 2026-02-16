## @hapi/vision Views Plugin Reference


Vision is a **hapi plugin** that adds template rendering support. It decorates the server, request, and response toolkit with view methods after registration via `server.register()`.

    const Hapi = require('@hapi/hapi');
    const Vision = require('@hapi/vision');

    const server = Hapi.server({ port: 3000 });
    await server.register(Vision);

    server.views({
        engines: { html: require('handlebars') },
        relativeTo: __dirname,
        path: 'templates'
    });


### Registration


Vision is registered like any hapi plugin. See [plugins](../server/plugins.md) for registration patterns.

    await server.register(require('@hapi/vision'));

After registration, vision adds:

| Decoration | Type | Description |
|---|---|---|
| `server.views(options)` | Server method | Configures the views manager for the current [realm](../server/realm.md) |
| `server.render(template, context, options)` | Server method | Renders a template and returns the string result |
| `h.view(template, context, options)` | [Toolkit](../lifecycle/response-toolkit.md) method | Returns a response object with variety `'view'` |
| `request.render(template, context, options)` | Request decoration | Renders a template within the request's route realm |
| `request.getViewsManager()` | Request decoration | Returns the closest views manager to the request's realm |
| `server.getViewsManager()` | Server decoration | Returns the views manager for the current server realm. (lib/index.js) |
| `h.getViewsManager()` | [Toolkit](../lifecycle/response-toolkit.md) decoration | Returns the closest views manager in the toolkit's realm chain. (lib/index.js) |
| `handler: { view: ... }` | [Handler type](../route/handler.md) | Registered handler for declarative template rendering |

Vision respects hapi's [realm](../server/realm.md) system. Each plugin can call `server.views()` independently, and routes within that plugin will use its views manager. The manager lookup walks up the realm chain to find the nearest configured manager.


### `server.views(options)`


Configures the views manager on the current server realm. Can be called multiple times -- each call within a plugin scope creates an isolated manager for that [realm](../server/realm.md). (lib/index.js)

    server.views({
        engines: {
            html: require('handlebars'),
            pug: require('pug')
        },
        relativeTo: __dirname,
        path: 'templates',
        layoutPath: 'templates/layouts',
        partialsPath: 'templates/partials',
        helpersPath: 'templates/helpers',
        layout: true,
        isCached: true
    });

| Option | Type | Default | Description |
|---|---|---|---|
| `engines` | `object` | **required** | Maps file extensions to engine objects. Each key is an extension (without dot), value is an engine module or config object. See [engines](engines.md). |
| `path` | `string \| string[]` | `'.'` | Template file lookup directory. Can be an array -- searched in order. Relative to `relativeTo`. |
| `relativeTo` | `string` | -- | Base directory for resolving relative paths in `path`, `layoutPath`, `partialsPath`, `helpersPath`. |
| `compileOptions` | `object` | `{}` | Options passed to the engine's `compile()` function. |
| `runtimeOptions` | `object` | `{}` | Options passed to the compiled template function at render time. |
| `layout` | `boolean \| string` | `false` | Enable layouts. `true` uses `'layout'` as the default layout filename. A string specifies the default layout name. See [context](context.md). |
| `layoutPath` | `string` | -- | Directory for layout templates. Defaults to `path` if not set. Relative to `relativeTo`. |
| `layoutKeyword` | `string` | `'content'` | The variable name in the layout template where the view content is injected. |
| `encoding` | `string` | `'utf8'` | Character encoding for reading template files. |
| `isCached` | `boolean` | `true` | Cache compiled templates. Set to `false` during development for hot-reload. |
| `allowAbsolutePaths` | `boolean` | `false` | Allow absolute paths in template names. When `false`, absolute paths throw. |
| `allowInsecureAccess` | `boolean` | `false` | Allow template paths that traverse above `relativeTo` (e.g., `../secret`). When `false`, path traversal throws. |
| `contentType` | `string` | `'text/html'` | Default `Content-Type` header for view responses. |
| `compileMode` | `string` | `'sync'` | `'sync'` or `'async'`. When `'async'`, the engine's `compile()` must return a promise or call a callback. See [engines](engines.md). |
| `defaultExtension` | `string` | -- | Default file extension appended to template names that lack one. |
| `context` | `object \| function` | -- | Default context merged into every view render. See [context](context.md). |
| `partialsPath` | `string \| string[]` | -- | Directory for partial templates (Handlebars-style). Relative to `relativeTo`. |
| `helpersPath` | `string \| string[]` | -- | Directory for helper modules. Relative to `relativeTo`. |

**Engine-level overrides:** Most options (except `engines`) can also be set per-engine inside the engine config object. Engine-level settings override manager-level settings. See [engines](engines.md).


### `h.view(template, [context, [options]])`


Returns a [response object](../lifecycle/response-object.md) with variety `'view'`. The response is rendered during the [marshal pipeline](../lifecycle/response-marshal.md) -- the template is not compiled until the response is being sent.

    const handler = function (request, h) {

        return h.view('profile', {
            user: request.auth.credentials.user
        });
    };

| Parameter | Type | Description |
|---|---|---|
| `template` | `string` | Template filename relative to the configured `path`. Extension optional if `defaultExtension` is set. |
| `context` | `object` | Data passed to the template. Merged with `defaultContext` if configured. See [context](context.md). |
| `options` | `object` | Per-response overrides for views manager settings. Cannot override `isCached`, `partialsPath`, or `helpersPath`. |

The response flows through the standard [lifecycle](../lifecycle/overview.md) -- `onPreResponse` can intercept view responses. Check `request.response.variety === 'view'` to detect them.

    server.ext('onPreResponse', (request, h) => {

        if (request.response.variety === 'view') {
            // Modify view response headers, inject context, etc.
        }

        return h.continue;
    });


### `server.render(template, context, [options])`


Renders a template and returns the resulting string. Useful outside of request handlers (e.g., generating email HTML).

    const html = await server.render('email', {
        name: 'John',
        resetLink: 'https://example.com/reset/abc'
    });

| Parameter | Type | Description |
|---|---|---|
| `template` | `string` | Template filename relative to `path`. |
| `context` | `object` | Data for the template. |
| `options` | `object` | Per-render overrides for views manager settings. |

Uses the views manager from the server's current [realm](../server/realm.md). In a plugin, it uses that plugin's views manager.


### `request.render(template, context, [options])`


Same as `server.render()` but inherits the realm from the route the request was bound to. Intended for use inside request handlers when you need the rendered string (not a response object).

    server.route({
        method: 'GET',
        path: '/preview',
        handler: async function (request, h) {

            const html = await request.render('preview', {
                items: request.pre.items
            });

            return { html };  // Return as JSON with rendered HTML
        }
    });

Does not work reliably in `onRequest` extensions because the route is not yet set at that lifecycle step.


### `request.getViewsManager()`


Returns the closest views manager to the request's route realm. Walks up the [realm chain](../server/realm.md) until a configured manager is found. Returns `undefined` if no manager exists.


### View Handler Type


Vision registers a `'view'` [handler type](../route/handler.md) via `server.decorate('handler', 'view', ...)`. This provides a declarative alternative to `h.view()`.

    server.route({
        method: 'GET',
        path: '/about',
        handler: { view: 'about' }
    });

The `view` value can be a string (template name) or an object:

| Option | Type | Description |
|---|---|---|
| `template` | `string` | Template filename. Required if using object form. |
| `context` | `object` | Context data for rendering. |
| `options` | `object` | Per-response view manager overrides. Cannot override `isCached`, `partialsPath`, or `helpersPath`. |

    server.route({
        method: 'GET',
        path: '/dashboard',
        handler: {
            view: {
                template: 'dashboard',
                context: { title: 'Dashboard' },
                options: { layout: 'admin' }
            }
        }
    });

When using the view handler with no explicit `context`, the default context includes `params`, `payload`, `query`, and `pre` values from the request -- making it convenient for simple pages:

    // Template can access {{params.id}}, {{query.tab}}, etc.
    server.route({
        method: 'GET',
        path: '/item/{id}',
        handler: { view: 'item' }
    });


### Gotchas


- **Realm scoping.** Each plugin's `server.views()` call creates an isolated views manager. Routes in that plugin use its manager. If a plugin does not call `server.views()`, it inherits from the parent realm. This is the same walkup pattern used by [validators](../server/realm.md).
- **`isCached: false` in production.** Disabling template caching causes every request to read and compile the template from disk. Only use during development.
- **`allowAbsolutePaths` and `allowInsecureAccess` are security guards.** They default to `false` to prevent template injection attacks where user input could reference arbitrary files. Only enable if template names are fully trusted.
- **View handler default context.** The `{ view: 'template' }` handler automatically injects `params`, `payload`, `query`, and `pre` into the context. The `h.view()` method does **not** do this -- you must pass context explicitly.
- **`h.view()` options cannot override `isCached`, `partialsPath`, or `helpersPath`.** These are locked at manager configuration time. Only path-related and compile-related options can be overridden per-response.
- **Template rendering happens during marshalling.** Errors in template compilation or rendering surface during the [marshal pipeline](../lifecycle/response-marshal.md), not when `h.view()` is called. The error passes through `onPreResponse` as a [Boom](../lifecycle/boom.md) 500 error.
- **`contentType` defaults to `text/html`.** If rendering non-HTML templates (e.g., XML, plain text), set `contentType` in the views manager or override it per-response.
- **Vision must be registered before `server.views()` is called.** Calling `server.views()` without registering Vision throws. The method is added as a server decoration during plugin registration.

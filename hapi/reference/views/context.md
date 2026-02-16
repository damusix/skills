## View Context, Layouts, Partials, and Helpers


This document covers how data flows into templates, how layouts wrap content, and how partials and helpers extend template capabilities. See [overview](overview.md) for registration and [engines](engines.md) for engine configuration.


### Context Resolution


The context object passed to a template is assembled from multiple sources depending on the rendering method used.

**`h.view(template, context)`** -- the context is exactly what you pass. No automatic injection:

    // Only { user } is available in the template
    return h.view('profile', { user: request.auth.credentials });

**View handler `{ view: 'template' }`** -- when no explicit context is provided, vision automatically injects request data:

    server.route({
        method: 'POST',
        path: '/search',
        handler: { view: 'results' }
    });

    // Template receives: { params, payload, query, pre }
    // e.g., {{query.q}}, {{payload.filter}}, {{params.id}}

| Source | Property | Description |
|---|---|---|
| `request.params` | `params` | Route path parameters |
| `request.payload` | `payload` | Request body |
| `request.query` | `query` | Query string parameters |
| `request.pre` | `pre` | [Pre-handler](../route/pre.md) results |

When the view handler **does** have an explicit `context`, the automatic injection does not occur:

    handler: {
        view: {
            template: 'results',
            context: { title: 'Search' }   // Only { title } available, no auto-inject
        }
    }


### Default Context (`context` option)


The `context` option in `server.views()` sets default context data merged into every template render. It can be a static object or a function.

**Static object:**

    server.views({
        engines: { html: require('handlebars') },
        path: 'templates',
        context: {
            siteName: 'My App',
            year: new Date().getFullYear()
        }
    });

    // Every template receives { siteName, year } plus any per-render context
    // Per-render context properties override defaults with the same key

**Function (called per-render with the request):**

    server.views({
        engines: { html: require('handlebars') },
        path: 'templates',
        context: function (request) {

            return {
                siteName: 'My App',
                isAuthenticated: request && request.auth.isAuthenticated,
                user: request && request.auth.credentials
            };
        }
    });

The function receives the `request` object when rendering within a request lifecycle (via `h.view()` or view handler). When called via `server.render()` outside a request, the argument is `null`.

**Merge order:** default context (from `context` option) is applied first, then per-render context overlays it. Per-render values win on key conflicts.


### Layout System


Layouts wrap rendered view content in a shared outer template (e.g., HTML shell with `<head>`, navigation, footer).

**Enable layouts:**

    server.views({
        engines: { html: require('handlebars') },
        path: 'templates',
        layout: true,              // Uses 'layout' as default filename
        layoutPath: 'templates/layouts'
    });

    // Or specify a named default layout:
    server.views({
        engines: { html: require('handlebars') },
        path: 'templates',
        layout: 'default',        // Uses 'default.html' as layout
        layoutPath: 'templates/layouts'
    });

**Layout template** receives the rendered view content via the `layoutKeyword` variable (default: `'content'`):

    <!-- templates/layouts/layout.html -->
    <!DOCTYPE html>
    <html>
    <head><title>{{title}}</title></head>
    <body>
        {{{content}}}
    </body>
    </html>

The triple-brace `{{{content}}}` (Handlebars) is required to inject raw HTML without escaping. Other engines use their equivalent raw output syntax.

**Per-response layout override:**

    return h.view('dashboard', context, { layout: 'admin' });

    // Or disable layout for a specific response:
    return h.view('fragment', context, { layout: false });

| Option | Type | Default | Description |
|---|---|---|---|
| `layout` | `boolean \| string` | `false` | `true` uses `'layout'` as filename. String specifies the layout name. `false` disables. |
| `layoutPath` | `string` | same as `path` | Directory for layout templates. Relative to `relativeTo`. |
| `layoutKeyword` | `string` | `'content'` | Variable name in the layout where the rendered view is injected. |

**How it works internally:** Vision renders the view template first, then passes the result as `{ [layoutKeyword]: renderedView, ...context }` to the layout template. The layout is compiled and rendered with the same engine.


### Partials


Partials are reusable template fragments loaded from the `partialsPath` directory. Vision automatically registers them with the engine.

    server.views({
        engines: { html: require('handlebars') },
        path: 'templates',
        partialsPath: 'templates/partials'
    });

    // templates/partials/header.html
    <header><h1>{{siteName}}</h1></header>

    // templates/home.html
    {{> header}}
    <main>{{message}}</main>

Vision calls `engine.registerPartial(name, source)` for each file found in `partialsPath`. The partial name is the filename without extension.

**Nested partials:** Subdirectories in `partialsPath` create namespaced partial names using `/` separators:

    // templates/partials/nav/sidebar.html
    // Referenced as: {{> nav/sidebar}}

Partials are loaded and registered once at manager initialization (or on first render if uncached). They follow the same caching rules as templates.


### Helpers


Helpers are JavaScript functions loaded from the `helpersPath` directory and registered with the engine.

    server.views({
        engines: { html: require('handlebars') },
        path: 'templates',
        helpersPath: 'templates/helpers'
    });

    // templates/helpers/formatDate.js
    module.exports = function (date) {

        return new Date(date).toLocaleDateString();
    };

    // templates/home.html
    <p>Published: {{formatDate publishedAt}}</p>

Each file in `helpersPath` is loaded via `require()`. The filename (without extension) becomes the helper name. Vision calls `engine.registerHelper(name, fn)` for each.

**Subdirectory helpers are not supported.** Unlike partials, the helper loading logic skips subdirectories entirely. (lib/manager.js:199) Place all helper files directly in `helpersPath`.


### TypeScript Support


Vision provides type augmentation interfaces for strict template/context typing:

    declare module '@hapi/vision' {

        type CustomTemplates = 'home' | 'profile' | 'dashboard';

        type CustomLayout = 'default' | 'admin' | 'minimal';

        interface RenderMethod {
            (template: CustomTemplates, context?: object): Promise<string>;
        }

        interface RequestRenderMethod {
            (template: CustomTemplates, context?: object): Promise<string>;
        }

        interface ToolkitRenderMethod {
            (template: CustomTemplates, context?: object): ResponseObject;
        }
    }

This enables compile-time validation of template names and context shapes.


### Gotchas


- **View handler auto-context vs `h.view()`.** The `{ view: 'template' }` handler injects `params`, `payload`, `query`, and `pre` automatically when no explicit context is given. `h.view()` never does this. Mixing the two patterns in the same codebase can lead to confusion about what data templates receive.
- **`context` function receives `null` for `server.render()`.** When rendering outside a request (e.g., email generation), the context function's argument is `null`. Always guard: `request && request.auth.credentials`.
- **Layout keyword must match engine syntax.** The default `'content'` works with Handlebars (`{{{content}}}`), but if your engine uses a different variable injection mechanism, you may need a custom `layoutKeyword`.
- **Layout renders after the view.** The view is compiled and rendered first. The resulting HTML string is then passed to the layout as `context[layoutKeyword]`. Errors in the view surface before layout rendering begins.
- **Partials require `registerPartial` on the engine.** Not all engines support this method. Engines without `registerPartial` (e.g., Pug, EJS) use their own include/partial mechanisms -- `partialsPath` has no effect for those engines.
- **Helpers require `registerHelper` on the engine.** Same limitation as partials. Handlebars supports this natively. For other engines, register helpers directly on the engine module before calling `server.views()`.
- **Partials and helpers are reloaded when uncached.** With `isCached: false`, partials and helpers are re-read and re-registered on each render, not just at initialization. (lib/manager.js:282-285) This enables hot-reload during development.
- **`partialsPath` and `helpersPath` cannot be overridden per-response.** These are locked at manager configuration time, unlike `layout` and `path` which can be overridden in `h.view()` options.
- **Context merge is shallow.** Default context and per-render context are merged at the top level only. Nested objects are replaced, not deep-merged. Structure your context accordingly.

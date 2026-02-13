## hapi Plugin System Overview


Plugins are the primary mechanism for organizing hapi application code into reusable, composable components. Each plugin receives a sandboxed `server` object that isolates certain settings (file paths, bind context, route prefixes) from other plugins while still sharing the same underlying server.


### Plugin Object Structure


A plugin is a plain object with a `register` function and identifying metadata. Two naming forms are supported -- provide `name` (and optionally `version`) directly, or provide `pkg` pointing to the module's `package.json`. You cannot use both. As an alternative to specifying `name` and `version` directly, you can use `pkg: require('./package.json')` to pull both values from the module's `package.json` automatically.

| Property | Required | Type | Default | Description |
|---|---|---|---|---|
| `register` | Yes | `async function(server, options)` | -- | Registration function. `server` has a plugin-scoped realm. `options` comes from the caller. |
| `name` | Yes* | `string` | -- | Unique plugin name. Published plugins should match their `package.json` name. |
| `version` | No | `string` | -- | Informational version string. Used by other plugins and `server.registrations`. |
| `pkg` | Yes* | `object` | -- | Alternative to `name`/`version`. Pass `require('./package.json')`. |
| `multiple` | No | `boolean` | `false` | If `true`, the plugin can be registered more than once on the same server. |
| `once` | No | `boolean` | no override | If `true`, silently skip re-registration. Overrides the `once` option passed to `server.register()`. |
| `dependencies` | No | `string \| string[] \| Record<string, string>` | -- | Required plugins. Same as calling `server.dependency()` inside `register`. |
| `requirements` | No | `{ node?: string; hapi?: string }` | all allowed | Semver range constraints for Node.js and hapi versions. Only loads if the runtime meets the version constraints. |

*Either `name` or `pkg` is required, not both.

**Minimal plugin:**

```js
    const plugin = {
        name: 'my-plugin',
        version: '1.0.0',
        register: function (server, options) {

            server.route({
                method: 'GET',
                path: '/hello',
                handler: (request, h) => 'hello'
            });
        }
    };
```

**Using `pkg` shorthand:**

```js
    const plugin = {
        pkg: require('./package.json'),
        register: function (server, options) {

            // name and version come from package.json
        }
    };
```


### The register Function


The `register` function is `async function(server, options)`:

- `server` -- a server reference with a **plugin-specific `server.realm`**. Routes, extensions, bind context, and file paths set through this reference are scoped to the plugin.
- `options` -- whatever the caller passed during `server.register()`. Defaults to `{}`.

Inside `register`, the plugin typically calls `server.route()`, `server.ext()`, `server.expose()`, `server.dependency()`, `server.bind()`, `server.decorate()`, and other server methods.

```js
    exports.plugin = {
        name: 'greeting',
        register: async function (server, options) {

            server.bind({ greeting: options.greeting || 'hello' });

            server.route({
                method: 'GET',
                path: '/greet/{name}',
                handler: function (request, h) {

                    // this === bound context from server.bind()
                    return `${this.greeting}, ${request.params.name}`;
                }
            });
        }
    };
```


### server.realm Inside Plugins


Each plugin gets its own `server.realm` sandbox. The realm isolates:

| Realm Property | Description |
|---|---|
| `modifiers.route.prefix` | Route path prefix applied to all `server.route()` calls in this plugin. |
| `modifiers.route.vhost` | Virtual host applied to all routes in this plugin. |
| `parent` | The realm of the parent server (or `null` for root). |
| `plugin` | Active plugin name (empty string at root). |
| `pluginOptions` | The options passed at registration. |
| `plugins` | Plugin-specific state object. Each key is a plugin name. |
| `settings.files.relativeTo` | Default relative path for file operations. |
| `settings.bind` | Default bind context for routes and extensions in this plugin. |

The realm should be treated as read-only except for the `plugins` property, which each plugin may manipulate directly under `plugins[name]`.

```js
    exports.plugin = {
        name: 'my-plugin',
        register: function (server, options) {

            console.log(server.realm.modifiers.route.prefix); // e.g., '/api'
            console.log(server.realm.plugin);                 // 'my-plugin'
            console.log(server.realm.pluginOptions);          // options
        }
    };
```


### Route Prefix and Virtual Host


When registering a plugin, you can apply a `prefix` and/or `vhost` via the `routes` option. These are stored in the plugin's realm and automatically applied to every route the plugin adds.

```js
    await server.register(require('./api-plugin'), {
        routes: {
            prefix: '/api/v1',
            vhost: 'api.example.com'
        }
    });
```

**Prefix stacking:** If a plugin registers a child plugin, the parent prefix is prepended to the child prefix. Given parent prefix `/api` and child prefix `/users`, routes in the child use `/api/users`.

**Vhost override:** The outer-most `vhost` overrides any nested configuration.

**Gotcha:** If a prefix is used and a route path is `'/'`, the resulting path does **not** include a trailing slash. With prefix `/api`, a route at `'/'` becomes `/api` (not `/api/`).


### Plugin Dependencies


Dependencies ensure that required plugins are registered before the server initializes or starts. There are two ways to declare them.

**Static (plugin property):**

```js
    exports.plugin = {
        name: 'my-plugin',
        dependencies: ['vision', 'inert'],          // array form
        // dependencies: { vision: '7.x.x' },       // version range form
        // dependencies: 'vision',                   // single string form
        register: function (server, options) { }
    };
```

**Dynamic (inside register):**

```js
    exports.plugin = {
        name: 'my-plugin',
        register: function (server, options) {

            server.dependency('yar', async (server) => {

                // This runs after all dependencies are registered,
                // before server starts (same timing as onPreStart).
                // Safe to use yar APIs here.
            });
        }
    };
```

`server.dependency()` accepts the same forms as the static `dependencies` property -- a string, an array of strings, or a version range object. The optional `after` callback is identical to an `onPreStart` extension.

**Dependency forms:**

| Form | Example | Description |
|---|---|---|
| Single string | `'yar'` | Requires plugin `yar` to be registered. |
| Array | `['yar', 'vision']` | Requires all listed plugins. |
| Version map | `{ yar: '10.x.x' }` | Requires plugin `yar` matching semver range. |

**Gotchas:**
- Dependencies are validated at `server.initialize()` or `server.start()`, not at registration time.
- Circular dependencies (two plugins each with an `after` depending on the other) throw an exception.
- The static `dependencies` property does not support an `after` callback; use `server.dependency()` for that.


### Multiple Registrations and the once/multiple Flags


By default, registering the same plugin twice on the same server throws an error. Two flags control this behavior:

| Flag | Location | Effect |
|---|---|---|
| `multiple: true` | Plugin property | Allows multiple registrations. Each call to `register()` executes. |
| `once: true` | Plugin property | Silently skips re-registration. Overrides the `once` option on `server.register()`. |
| `once: true` | `server.register()` option | Silently skips re-registration. Cannot be used with plugin options. |

**Precedence:** The plugin's own `once` property overrides the `once` option passed to `server.register()`.

```js
    // Plugin that explicitly allows multiple registrations
    const counters = {
        name: 'counters',
        multiple: true,
        register: function (server, options) {

            server.route({
                method: 'GET',
                path: `/${options.name}`,
                handler: () => ({ count: 0 })
            });
        }
    };

    await server.register({ plugin: counters, options: { name: 'hits' } });
    await server.register({ plugin: counters, options: { name: 'errors' } });
```


### Plugin Communication


#### server.bind(context)


Sets a global context for all route handlers and extension methods added by the current plugin. When a function is bound, `this` inside `function`-style (non-arrow) handlers refers to the bound context.

    server.bind({ db: databaseClient });

    server.route({
        method: 'GET',
        path: '/users',
        handler: function (request, h) {

            return this.db.query('SELECT * FROM users');
        }
    });

Only affects handlers registered after the `bind()` call. Each plugin can have its own binding without affecting other plugins.


#### server.expose(key, value, [options])


Exposes a property on `server.plugins[pluginName]`. Stores a **reference** (not a clone) to `value`.

```js
    server.expose('dbClient', databaseClient);
    // Accessible as: server.plugins['my-plugin'].dbClient
```

**Scope option** for scoped package names (e.g., `@hapi/test`):

| `options.scope` | Key in `server.plugins` |
|---|---|
| `false` (default) | `server.plugins.test` |
| `true` | `server.plugins['@hapi/test']` |
| `'underscore'` | `server.plugins.hapi__test` |


#### server.expose(obj) -- merge form


Merges all properties of `obj` into `server.plugins[pluginName]`. Properties are **deeply cloned**. Avoid for large objects or singletons (database clients, event emitters) -- use the key-value form instead.

```js
    server.expose({ helper: myHelper, version: '1.0.0' });
```


#### server.plugins


Read/write object where each key is a plugin name and values are exposed properties. You can also assign directly:

```js
    // Inside plugin:
    server.expose('key', 'value');
    server.plugins['my-plugin'].other = 'other';     // direct assignment

    // From another plugin or route:
    const client = server.plugins['db-plugin'].client;
```


#### request.plugins


Read/write per-request plugin state. Each key is a plugin name, value is plugin-specific state for that request. Resets every request.

```js
    // In an onRequest extension:
    request.plugins['my-plugin'] = { startTime: Date.now() };

    // In a route handler:
    const elapsed = Date.now() - request.plugins['my-plugin'].startTime;
```


### server.registrations


Read-only object of currently registered plugins. Each key is a plugin name, value contains:

| Property | Type | Description |
|---|---|---|
| `version` | `string` | Plugin version. |
| `name` | `string` | Plugin name. |
| `options` | `object` | Options passed during registration. |

```js
    if (server.registrations.vision) {
        // vision is registered
    }
```


### Plugin Registration Lifecycle


1. `server.register()` is called -- the plugin's `register(server, options)` executes immediately.
2. Inside `register()`, the plugin calls `server.route()`, `server.ext()`, `server.expose()`, `server.dependency()`, etc.
3. After all plugins are registered, `server.initialize()` or `server.start()` is called.
4. Dependencies are validated -- missing dependencies throw an error.
5. `dependency.after` callbacks execute (same timing as `onPreStart` extensions).
6. Server lifecycle extensions fire in order (`onPreStart`, `onPostStart`).
7. Server is ready.

Return value of `server.register()`: none. Resolves when registration completes.


### TypeScript


#### Plugin<Options, Decorations>


The `Plugin` type accepts two generic parameters:

| Parameter | Default | Description |
|---|---|---|
| `T` | -- | Type of the options passed to the `register` function. Use `void` for no options. |
| `D` | `void` | Declares server decorations the plugin provides (e.g., typed `server.plugins` entries). |

`Plugin<T, D>` is a union of `NamedPlugin<T, D>` (has `name`/`version`) and `PackagedPlugin<T, D>` (has `pkg`).

```typescript
    import { Plugin, Server } from '@hapi/hapi';

    interface MyOptions {
        threshold: number;
    }

    interface MyDecorations {
        plugins: {
            'my-plugin': {
                check(value: number): boolean;
            };
        };
    }

    const myPlugin: Plugin<MyOptions, MyDecorations> = {
        name: 'my-plugin',
        version: '1.0.0',
        dependencies: ['vision'],
        requirements: { hapi: '>=21.0.0' },
        register: async (server, options) => {

            // options is typed as MyOptions
            server.expose('check', (value: number) => value > options.threshold);
        }
    };

    // server.register() resolves when registration completes.
    // The returned Promise type is Promise<this & D>, where the intersection
    // type narrows the server to include any decorations declared by the plugin.
    await server.register({
        plugin: myPlugin,
        options: { threshold: 10 }
    });

    // After registration, access exposed properties via server.plugins directly.
    const result: boolean = server.plugins['my-plugin'].check(15);
```


#### PluginProperties Augmentation


For application-wide type safety on `server.plugins`, augment the `PluginProperties` interface:

```typescript
    declare module '@hapi/hapi' {
        interface PluginProperties {
            'my-plugin': {
                check(value: number): boolean;
            };
        }
    }
```

After augmentation, `server.plugins['my-plugin'].check` is typed across the entire application without needing the `D` generic parameter on every reference.


#### PluginsStates Augmentation


For typed `request.plugins` access:

```typescript
    declare module '@hapi/hapi' {
        interface PluginsStates {
            'my-plugin': {
                requestStartTime: number;
            };
        }
    }

    // Now typed:
    request.plugins['my-plugin'].requestStartTime;
```


#### ServerRegisterPluginObject


For typed registration objects that bundle plugin, options, and registration settings:

```typescript
    import { ServerRegisterPluginObject } from '@hapi/hapi';

    const registration: ServerRegisterPluginObject<MyOptions, MyDecorations> = {
        plugin: myPlugin,
        options: { threshold: 10 },
        routes: { prefix: '/api' }
    };

    await server.register(registration);
```


### Best Practices


- **Use `server.dependency()` with `after`** to safely defer logic that depends on other plugins until after all registrations complete.
- **Expose public API via `server.expose(key, value)`** (not the merge form) for singletons and large objects to avoid deep cloning.
- **Use `request.plugins[name]`** for per-request state; use `server.plugins[name]` for shared plugin state.
- **Declare `requirements`** to fail early if the plugin is loaded on an incompatible Node.js or hapi version.
- **Prefer `pkg: require('./package.json')`** for published plugins to keep name/version in sync with npm.
- **Set `once: true`** on utility plugins that should be safe to register from multiple dependents without error.
- **Avoid setting `multiple: true`** unless the plugin genuinely needs to register different route sets or state per invocation.
- **Use TypeScript module augmentation** (`PluginProperties`, `PluginsStates`) for type safety that propagates across plugin boundaries.

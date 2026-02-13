## hapi Server Plugins Reference


### server.register(plugins, [options])


Registers one or more plugins.

Return value: none. The TypeScript types declare `Promise<void>` (or `Promise<this & D>` for type narrowing with plugin decorations), but at runtime the resolved value is not used.

**Single plugin:**

```js
    await server.register(require('@hapi/vision'));
```

**With plugin options:**

```js
    await server.register({
        plugin: require('@hapi/good'),
        options: {
            reporters: {
                console: [{ module: '@hapi/good-console' }]
            }
        }
    });
```

**Array of plugins:**

```js
    await server.register([
        require('@hapi/inert'),
        require('@hapi/vision'),
        {
            plugin: require('@hapi/good'),
            options: { reporters: { /* ... */ } }
        }
    ]);
```

**Registration options (second argument):**

| Option          | Type                 | Default | Description                                                                                                     |
| --------------- | -------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `once`          | `boolean`            | `false` | Skip duplicate registrations silently. Cannot be used with plugin options.                                      |
| `routes.prefix` | `string`             | none    | Path prefix added to all routes registered by the plugin (must start with `'/'`). Nested plugin prefixes stack. |
| `routes.vhost`  | `string \| string[]` | none    | Virtual host applied to every route. Outer-most vhost overrides nested ones.                                    |

```js
    await server.register(require('./my-plugin'), {
        once: true,
        routes: {
            prefix: '/api/v1',
            vhost: 'api.example.com'
        }
    });
```

**Per-plugin options inline:** `once` and `routes` can also be set per-plugin when using the object form:

```js
    await server.register([
        {
            plugin: require('./my-plugin'),
            options: { debug: true },
            once: true,
            routes: { prefix: '/api' }
        }
    ]);
```

**Gotchas:**
- If `once` is not `true`, registering the same plugin twice throws an error.
- The `options` object is deeply cloned (except `bind` which is shallow-copied).
- If a started server is started again after registering new plugins, the second `server.start()` is ignored -- no events or extension points fire.


### server.expose(key, value, [options])


Used inside a plugin to expose a property on `server.plugins[name]`. Only copies a **reference** to `value`.

```js
    exports.plugin = {
        name: 'example',
        register: function (server, options) {

            server.expose('db', databaseClient);
            // Access: server.plugins.example.db
        }
    };
```

**Scope options** (for scoped package names like `@hapi/test`):

| `options.scope`   | Result for `@hapi/test`        |
| ----------------- | ------------------------------ |
| `false` (default) | `server.plugins.test`          |
| `true`            | `server.plugins['@hapi/test']` |
| `'underscore'`    | `server.plugins.hapi__test`    |


### server.expose(obj) -- merge form


Merges an object into `server.plugins[name]`. All properties of `obj` are **deeply cloned**.

```js
    exports.plugin = {
        name: 'example',
        register: function (server, options) {

            server.expose({ util: myUtil, config: myConfig });
        }
    };
```

**When to use which form:**
- Use `server.expose(key, value)` for large objects, singletons (e.g., database clients), or anything expensive to clone -- it only stores a reference.
- Use `server.expose(obj)` when you want to merge multiple small values at once -- but be aware of the deep clone cost.


### server.dependency(dependencies, [after])


Used inside a plugin to declare required dependencies. Listed plugins must be registered before the server is initialized or started.

**Arguments:**

| Parameter      | Type                           | Description                                                                            |
| -------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| `dependencies` | `string \| string[] \| object` | Plugin name(s) or object with name-to-semver-range pairs                               |
| `after`        | `async function(server)`       | Optional callback executed after all dependencies are registered, before server starts |

```js
    exports.plugin = {
        name: 'my-plugin',
        register: function (server, options) {

            // String form
            server.dependency('yar');

            // Array form
            server.dependency(['yar', 'vision']);

            // Version range form
            server.dependency({ yar: '10.x.x', vision: '7.x.x' });

            // With after callback (equivalent to onPreStart extension)
            server.dependency('yar', async (server) => {

                // Safe to use yar APIs here
                server.route({ /* ... */ });
            });
        }
    };
```

**Alternative:** Dependencies can be declared via the plugin `dependencies` property (does not support the `after` callback):

```js
    exports.plugin = {
        name: 'my-plugin',
        version: '1.0.0',
        dependencies: {
            yar: '10.x.x'
        },
        register: function (server, options) { }
    };
```

**Gotchas:**
- Circular dependencies (two plugins each declaring `after` depending on the other) throw an exception.
- The `after` callback is identical to registering an `onPreStart` server extension.
- Dependencies are only checked when the server is initialized or started -- not at registration time.


### server.plugins Access Pattern


`server.plugins` is a read/write object where each key is a plugin name and values are the exposed properties.

```js
    // Inside plugin registration:
    server.expose('key', 'value');
    server.plugins.example.other = 'other';    // Direct assignment also works

    console.log(server.plugins.example.key);   // 'value'
    console.log(server.plugins.example.other); // 'other'
```

**Cross-plugin access:**

```js
    // From another plugin or route handler:
    const dbClient = server.plugins['my-db-plugin'].client;
```


### Plugin Registration Lifecycle


1. `server.register()` is called -- plugin's `register(server, options)` executes.
2. Inside `register()`, the plugin calls `server.route()`, `server.ext()`, `server.expose()`, `server.dependency()`, etc.
3. After all plugins are registered, `server.initialize()` or `server.start()` is called.
4. Dependencies are validated -- missing dependencies throw an error.
5. `dependency.after` callbacks execute (same timing as `onPreStart` extensions).
6. Server extensions (`onPreStart`, `onPostStart`) fire in order.
7. Server is ready.

**Minimal plugin structure:**

```js
    exports.plugin = {
        name: 'my-plugin',
        version: '1.0.0',
        multiple: false,          // default: false; set true to allow multiple registrations
        dependencies: ['vision'], // static dependency declaration
        once: false,              // default: false; if true, skip re-registration silently
        register: async function (server, options) {

            server.expose('doSomething', () => { /* ... */ });
            server.route({ method: 'GET', path: '/health', handler: () => 'ok' });
        }
    };
```


### Plugin `requirements` Property


The optional `requirements` property specifies semver version constraints for the runtime environment. If the running Node.js or hapi version does not satisfy the constraints, plugin registration throws an error.

```js
    exports.plugin = {
        name: 'my-plugin',
        version: '1.0.0',
        requirements: {
            node: '>=16.0.0',
            hapi: '>=21.0.0'
        },
        register: async function (server, options) {

            // Only runs if Node >= 16 and hapi >= 21
        }
    };
```


### Plugin `pkg` Property


As an alternative to setting `name` and `version` directly, a plugin can use `pkg` to reference its `package.json`. The `name` and `version` fields are extracted automatically.

```js
    exports.plugin = {
        pkg: require('./package.json'),
        register: async function (server, options) {

            // name and version come from package.json
        }
    };
```

If both `pkg` and `name` are provided, `name` takes precedence.

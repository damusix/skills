## Server Realms


A realm is a **sandboxed namespace** attached to each `Server` instance. Every plugin registration creates a child server with its own realm, isolating configuration, extensions, and state from other plugins.


### Structure

Every realm has these properties (defined at `lib/server.js:52-77`):

```js
{
    _extensions: {
        onPreAuth, onCredentials, onPostAuth,
        onPreHandler, onPostHandler,
        onPreResponse, onPostResponse
    },
    modifiers: {
        route: {
            prefix: undefined,   // string — route path prefix
            vhost: undefined     // string — virtual host
        }
    },
    parent: null,                // ServerRealm | null — parent realm
    plugin: undefined,           // string — plugin name (undefined at root)
    pluginOptions: {},           // options passed at registration time
    plugins: {},                 // plugin-local writable state
    _rules: null,                // { processor, settings } from server.rules()
    settings: {
        bind: undefined,         // object — this context (server.bind())
        files: {
            relativeTo: undefined // string — base path (server.path())
        }
    },
    validator: null              // set by server.validator()
}
```


### How Realms Nest

When `server.register()` is called, a **child Server** is created via `server._clone(name)` (`lib/server.js:88-91`). The child gets a fresh realm whose `parent` points to the calling server's realm, forming a linked list up to root.

```js
// Inside register() — lib/server.js:456-460
const clone = this._clone(name);
clone.realm.modifiers.route.prefix = item.routes.prefix ?? options.routes.prefix;
clone.realm.modifiers.route.vhost = item.routes.vhost ?? options.routes.vhost;
clone.realm.pluginOptions = item.options ?? {};

await item.plugin.register(clone, item.options ?? {});
```

The plugin receives the cloned server. Anything the plugin does (routes, extensions, bindings) is scoped to its realm.


### Prefix Accumulation

When a plugin registers a child plugin, prefixes are **concatenated** (`lib/server.js:412-419`):

```js
options.routes.prefix = (this.realm.modifiers.route.prefix ?? '') +
                        (options.routes.prefix ?? '') || undefined;
```

So `/api` registering a child with `/users` results in `/api/users`. The outer `vhost` always wins over the inner one.

When a route path is `/`, the prefix alone becomes the path (no trailing slash):

```js
// lib/route.js:39
const path = realm.modifiers.route.prefix
    ? realm.modifiers.route.prefix + (route.path !== '/' ? route.path : '')
    : route.path;
```


### Settings Merge Order

Route configuration follows a 4-level priority chain (`lib/route.js:80-83`):

    server defaults < handler defaults < realm settings < rules config < route config

`realm.settings` (bind, files.relativeTo) overrides server defaults but is overridden by route-specific config.

If the route config is a **function**, it is called with `realm.settings.bind` as `this`:

```js
// lib/route.js:52-53
if (typeof config === 'function') {
    config = config.call(realm.settings.bind, server);
}
```


### Validator Chain Walkup

When a route needs a validator, hapi walks up the realm chain (`lib/validation.js:55-66`):

```js
while (realm) {
    if (realm.validator) {
        return realm.validator;
    }
    realm = realm.parent;
}
return core.validator;    // global fallback
```

A plugin calling `server.validator(joi)` sets validation for itself and all children that don't override it.


### Per-Realm Extensions

Each realm holds its own `Ext` instances for route lifecycle events. When `server.ext()` is called, the extension is tagged with the calling realm (`lib/server.js:276-279`).

At route construction, `Ext.combine()` merges three layers (`lib/ext.js:72-95`):

1. **Route-level** extensions (from `route.options.ext`)
2. **Server-wide** extensions (`core.extensions.route[type]`)
3. **Plugin-realm** extensions (`route.realm._extensions[type]`)

Routes **subscribe** to both server and realm extension lists, so extensions added after route registration still apply via `route.rebuild()`.

The `before`/`after` ordering uses `event.realm.plugin` as the group name.


### Auth Strategies Get Their Own Realm

When `server.auth.strategy()` is called, the server is cloned first (`lib/auth.js:63-76`):

```js
server = server._clone();
const strategy = this.#schemes[scheme](server, options);
this.#strategies[name] = {
    methods: strategy,
    realm: server.realm
};
```

The strategy can use `server.bind()`, `server.path()`, etc., in complete isolation. During authentication, the strategy's realm is passed to the toolkit so `h.realm` reflects the strategy's context.


### Rules Processors Walk the Chain

`server.rules(processor)` registers a rules processor on the current realm. At route construction, hapi walks from root to the current realm, applying each processor (`lib/route.js:475-489`):

```js
let realm = server.realm;
while (realm) {
    if (realm._rules) {
        const config = realm._rules.processor(source, info);
        if (config) {
            configs.unshift(config);   // parent configs go first (lower priority)
        }
    }
    realm = realm.parent;
}
```

Plugin-level rules override root rules on overlapping keys. The route's own config still beats all rules.


### `realm.plugins` vs `server.plugins`

These are completely different:

| Property | Scope | Purpose |
|---|---|---|
| `realm.plugins` | Per-server instance (plugin-local) | Private scratch space for the plugin |
| `server.plugins` | Global (shared via `core.plugins`) | Public data exposed via `server.expose()` |

The API states: *"The `server.realm` object should be considered read-only and must not be changed directly except for the `plugins` property."*

Usage pattern:

```js
// Inside a plugin
exports.register = function (server, options) {

    server.realm.plugins.myPlugin = { initialized: true };  // private state
    server.expose('publicApi', { doThing() {} });           // public via server.plugins.myPlugin.publicApi
};
```


### Where Realms Are Accessible

| Location | Access | Notes |
|---|---|---|
| `server.realm` | Direct property | The registering server's realm |
| `request.route.realm` | Via route public info | The realm of the plugin that registered the route |
| `h.realm` | Via response toolkit | Same as route realm; in `onRequest` defaults to root realm |
| Strategy realm | `lib/auth.js` internals | Passed to toolkit during authentication |


### Cache Segment Auto-Naming

When creating cache policies, hapi uses the realm's plugin name to auto-generate segment names (`lib/core.js:622-627`):

```js
const plugin = realm?.plugin;
const segment = options.segment ?? _segment ?? (plugin ? `!${plugin}` : '');
```

Convention: `!pluginName` for plugin-scoped cache segments.


### TypeScript Interface

```ts
interface ServerRealm {
    modifiers: {
        route: {
            prefix: string;
            vhost: string;
        }
    };
    parent: ServerRealm | null;
    plugin: string;
    pluginOptions: object;
    plugins: PluginsStates;
    settings: {
        files: { relativeTo: string };
        bind: object;
    };
}
```

Note: `_extensions`, `_rules`, and `validator` are internal — not exposed in the public TypeScript interface.


### Gotchas

- **Root server has `plugin: undefined`** — calling `server.dependency()` or `server.expose()` outside a plugin throws because they assert `this.realm.plugin` is truthy.
- **Server decorations are global** — `server.decorate('server', ...)` applies to ALL Server instances sharing the same core, regardless of realm. There is no realm-scoped decoration isolation.
- **Prefix + `/` path** — a plugin with `prefix: '/api'` adding a route at `path: '/'` produces `/api` (not `/api/`).
- **Extensions are live** — extensions added after routes are registered still apply because routes subscribe to realm extension lists for updates.
- **Arrow functions ignore bind** — `realm.settings.bind` sets `this` context, but arrow functions use lexical `this`. Use `function` declarations when you need the bind context.

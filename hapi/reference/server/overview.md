
## hapi Server Reference


Use when constructing a hapi server, configuring options, or accessing server properties.


### Server Constructor


```javascript
const Hapi = require('@hapi/hapi');

// Factory function (preferred)
const server = Hapi.server(options);

// Constructor form
const server = new Hapi.Server(options);
```

The `options` object is deeply cloned (except `listener`, which is shallow-copied). All options are optional.


### Server Options


#### `server.options.address`


| Property | Value                                        |
| -------- | -------------------------------------------- |
| Default  | `'::'` (IPv6) or `'0.0.0.0'` (IPv4 fallback) |
| Type     | `string`                                     |

The hostname or IP address the server listens on. Falls back to `host` if set, otherwise all available network interfaces.

```javascript
// Restrict to localhost only
const server = Hapi.server({ address: '127.0.0.1', port: 3000 });
```


#### `server.options.app`


| Property | Value    |
| -------- | -------- |
| Default  | `{}`     |
| Type     | `object` |

Static application-specific configuration, accessible later via `server.settings.app`. The framework does not interact with this object.

**Gotcha:** `server.settings.app` is for static config set at construction time. `server.app` is for runtime state. Do not confuse them.

```javascript
const server = Hapi.server({
    app: { apiVersion: 'v2', maxRetries: 3 }
});

// Later:
server.settings.app.apiVersion;  // 'v2'
```


#### `server.options.autoListen`


| Property | Value     |
| -------- | --------- |
| Default  | `true`    |
| Type     | `boolean` |

When `false`, the `listener` must be started manually outside the framework.

**Gotcha:** Cannot be `false` when a `port` value is also provided.


#### `server.options.cache`


| Property | Value                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------- |
| Default  | `{ provider: { constructor: require('@hapi/catbox-memory'), options: { partition: 'hapi-cache' } } }` |
| Type     | `object` or `array`                                                                                   |

Configures server-side caching providers using catbox. Caching is only used if methods or plugins explicitly store state in it. Accepts a single configuration or an array of configurations.

Each cache configuration item can be:

- A class/constructor (e.g., `require('@hapi/catbox-redis')`) -- a new catbox client is created internally.
- A configuration object with:

| Key                          | Required                   | Description                                                                        |
| ---------------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `engine`                     | one of `engine`/`provider` | A catbox engine object instance                                                    |
| `provider`                   | one of `engine`/`provider` | A class, constructor, or `{ constructor, options }` object                         |
| `provider.options.partition` | No                         | String to isolate cached data. Default: `'hapi-cache'`                             |
| `name`                       | No                         | Identifier for the cache. Must be unique. Omit for the default cache               |
| `shared`                     | No                         | If `true`, allows multiple cache users to share the same segment. Default: `false` |

```javascript
const server = Hapi.server({
    cache: [
        {
            name: 'redis',
            provider: {
                constructor: require('@hapi/catbox-redis'),
                options: {
                    partition: 'my-app',
                    host: '127.0.0.1',
                    port: 6379
                }
            }
        }
    ]
});
```

If every cache entry has a `name`, an additional default memory cache is provisioned automatically.


#### `server.options.compression`


| Property | Value                |
| -------- | -------------------- |
| Default  | `{ minBytes: 1024 }` |
| Type     | `object` or `false`  |

Set to `false` to disable all response content encoding. Otherwise an object with:

- `minBytes` -- minimum response payload size in bytes to apply compression. Default: `1024`.


#### `server.options.debug`


| Property | Value                             |
| -------- | --------------------------------- |
| Default  | `{ request: ['implementation'] }` |
| Type     | `object` or `false`               |

Controls which logged events go to the console. This is for development only and does not affect what is internally logged.

| Key       | Type                          | Default              | Description                                      |
| --------- | ----------------------------- | -------------------- | ------------------------------------------------ |
| `log`     | `string[]` or `false`         | none                 | Server log tags to display via `console.error()` |
| `request` | `string[]`, `'*'`, or `false` | `['implementation']` | Request log tags to display. `'*'` shows all     |

```javascript
// Show all errors
const server = Hapi.server({
    debug: { log: ['error'], request: ['error'] }
});

// Disable all debug output
const server = Hapi.server({ debug: false });

// Show everything
const server = Hapi.server({
    debug: { log: '*', request: '*' }
});
```


#### `server.options.host`


| Property | Value                         |
| -------- | ----------------------------- |
| Default  | OS hostname, or `'localhost'` |
| Type     | `string`                      |

The public hostname or IP address. Sets `server.info.host` and `server.info.uri`. Also used as `address` if no explicit address is provided.


#### `server.options.info.remote`


| Property | Value     |
| -------- | --------- |
| Default  | `false`   |
| Type     | `boolean` |

When `true`, `request.info.remoteAddress` and `request.info.remotePort` are populated immediately when the request is received (uses more resources). When `false`, they are populated on demand but will be `undefined` if accessed after the request is aborted.


#### `server.options.listener`


| Property | Value                       |
| -------- | --------------------------- |
| Default  | none                        |
| Type     | `http.Server` or compatible |

An optional node HTTP/HTTPS server object. When providing a custom listener:

- If it must be started manually, set `autoListen` to `false`.
- If it uses TLS, set `tls` to `true`.


#### `server.options.load`


| Property | Value                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| Default  | `{ sampleInterval: 0, maxHeapUsedBytes: 0, maxRssBytes: 0, maxEventLoopDelay: 0, maxEventLoopUtilization: 0 }` |
| Type     | `object`                                                                                                       |

Server excessive load handling. Requests are rejected with HTTP 503 when limits are exceeded.

| Key                       | Default | Description                                                |
| ------------------------- | ------- | ---------------------------------------------------------- |
| `sampleInterval`          | `0`     | Sampling frequency in ms. `0` disables all load monitoring |
| `maxHeapUsedBytes`        | `0`     | Max V8 heap size. `0` = no limit                           |
| `maxRssBytes`             | `0`     | Max process RSS. `0` = no limit                            |
| `maxEventLoopDelay`       | `0`     | Max event loop delay in ms. `0` = no limit                 |
| `maxEventLoopUtilization` | `0`     | Max event loop utilization (0-1). `0` = no limit           |

**Gotcha:** `sampleInterval` must be non-zero for any of the other load options to take effect.

```javascript
const server = Hapi.server({
    load: {
        sampleInterval: 1000,
        maxHeapUsedBytes: 500 * 1024 * 1024,
        maxEventLoopDelay: 1000
    }
});
```


#### `server.options.mime`


| Property | Value    |
| -------- | -------- |
| Default  | none     |
| Type     | `object` |

Options passed to the mimos module. Use `override` to merge custom MIME entries into the built-in database.

```javascript
const server = Hapi.server({
    mime: {
        override: {
            'node/module': {
                source: 'iana',
                compressible: true,
                extensions: ['node', 'module', 'npm'],
                type: 'node/module'
            }
        }
    }
});
```


#### `server.options.operations`


| Property | Value                 |
| -------- | --------------------- |
| Default  | `{ cleanStop: true }` |
| Type     | `object`              |

- `cleanStop` -- if `true`, tracks open connections and properly closes them on `server.stop()`. Set to `false` under severe load if the server is never gracefully stopped.


#### `server.options.plugins`


| Property | Value    |
| -------- | -------- |
| Default  | `{}`     |
| Type     | `object` |

Plugin-specific static configuration, keyed by plugin name. Accessible via `server.settings.plugins`.

**Gotcha:** `server.settings.plugins` is for static config. `server.plugins` is for runtime state exposed via `server.expose()`.


#### `server.options.port`


| Property | Value                |
| -------- | -------------------- |
| Default  | `0` (ephemeral port) |
| Type     | `number` or `string` |

The TCP port the server listens on. When `0`, an available port is assigned at start (see `server.info.port`).

Special string values:
- Contains `/` -- treated as a UNIX domain socket path.
- Starts with `\\.\pipe` -- treated as a Windows named pipe.

```javascript
// Specific port
const server = Hapi.server({ port: 3000 });

// UNIX domain socket
const server = Hapi.server({ port: '/var/run/hapi.sock' });
```


#### `server.options.query`


| Property | Value    |
| -------- | -------- |
| Default  | `{}`     |
| Type     | `object` |

- `parser` -- custom query string parser with signature `function(query)`. Must return an object of key-value pairs. If it throws, the error becomes the response.

```javascript
const Qs = require('qs');

const server = Hapi.server({
    query: {
        parser: (query) => Qs.parse(query)
    }
});
```


#### `server.options.router`


| Property | Value                                                  |
| -------- | ------------------------------------------------------ |
| Default  | `{ isCaseSensitive: true, stripTrailingSlash: false }` |
| Type     | `object`                                               |

| Key                  | Default | Description                                            |
| -------------------- | ------- | ------------------------------------------------------ |
| `isCaseSensitive`    | `true`  | Whether `/example` and `/EXAMPLE` are different routes |
| `stripTrailingSlash` | `false` | Remove trailing slashes from incoming paths            |


#### `server.options.routes`


| Property | Value    |
| -------- | -------- |
| Default  | none     |
| Type     | `object` |

A route options object used as the default configuration for every route. Any route-level config merges into/overrides these defaults.


#### `server.options.state`


| Property | Value     |
| -------- | --------- |
| Default  | see below |
| Type     | `object`  |

Default cookie configuration for all states (cookies):

```javascript
{
    strictHeader: true,
    ignoreErrors: false,
    isSecure: true,
    isHttpOnly: true,
    isSameSite: 'Strict',
    isPartitioned: false,
    encoding: 'none'
}
```


#### `server.options.tls`


| Property | Value              |
| -------- | ------------------ |
| Default  | none               |
| Type     | `object` or `true` |

Passed unchanged to the node HTTPS server. Set to `true` when providing a `listener` that already uses TLS.

```javascript
const Fs = require('fs');

const server = Hapi.server({
    port: 443,
    tls: {
        key: Fs.readFileSync('key.pem'),
        cert: Fs.readFileSync('cert.pem')
    }
});
```


#### `server.options.uri`


| Property | Value                                |
| -------- | ------------------------------------ |
| Default  | constructed from runtime server info |
| Type     | `string`                             |

The full public URI without the path (e.g., `'http://example.com:8080'`). If set, used as `server.info.uri`. Otherwise the URI is built from the server settings.


### Server Properties


#### `server.app`


| Access       | Type     |
| ------------ | -------- |
| read / write | `object` |

Runtime application state. Initialized as `{}`. Available wherever the server is accessible.

```javascript
server.app.db = dbConnection;

const handler = function (request, h) {

    return request.server.app.db.query('SELECT 1');
};
```

**Gotcha:** `server.app` is for runtime state. `server.settings.app` (from the `app` constructor option) is for static configuration.


#### `server.auth.api`


| Access            | Type     |
| ----------------- | -------- |
| strategy-specific | `object` |

An object keyed by strategy name, containing the `api` object returned from each scheme's implementation function. Only available when a scheme returns an `api` key.

```javascript
const scheme = function (server, options) {

    return {
        api: { settings: { x: 5 } },
        authenticate: function (request, h) {

            // ...
            return h.authenticated({ credentials: { user: 'john' } });
        }
    };
};

server.auth.scheme('custom', scheme);
server.auth.strategy('default', 'custom');

console.log(server.auth.api.default.settings.x);  // 5
```


#### `server.auth.settings.default`


| Access    | Type     |
| --------- | -------- |
| read only | `object` |

The default authentication configuration, if set via `server.auth.default()`.


#### `server.decorations`


| Access    | Type     |
| --------- | -------- |
| read only | `object` |

Lists decorations applied to framework interfaces. Do not modify directly; use `server.decorate()`.

| Key        | Description                         |
| ---------- | ----------------------------------- |
| `request`  | Decorations on the request object   |
| `response` | Decorations on the response object  |
| `toolkit`  | Decorations on the response toolkit |
| `server`   | Decorations on the server object    |

```javascript
server.decorate('toolkit', 'success', function () {

    return this.response({ status: 'ok' });
});

console.log(server.decorations.toolkit);  // ['success']
```


#### `server.events`


| Access                  | Type     |
| ----------------------- | -------- |
| podium public interface | `Podium` |

The server event emitter (uses podium). Key methods:

| Method                                         | Description                       |
| ---------------------------------------------- | --------------------------------- |
| `server.event(events)`                         | Register application events       |
| `server.events.emit(criteria, data)`           | Emit server events                |
| `server.events.on(criteria, listener)`         | Subscribe to all matching events  |
| `server.events.once(criteria, listener)`       | Subscribe to a single occurrence  |
| `server.events.removeListener(name, listener)` | Remove a listener                 |
| `server.events.removeAllListeners(name)`       | Remove all listeners for an event |
| `server.events.hasListeners(name)`             | Check for listeners               |

Built-in events:

| Event           | Handler Signature               | Description                                                             |
| --------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `'log'`         | `(event, tags)`                 | Internal server and `server.log()` events                               |
| `'cachePolicy'` | `(cachePolicy, cache, segment)` | When a cache policy is created                                          |
| `'request'`     | `(request, event, tags)`        | Internal request and `request.log()` events                             |
| `'response'`    | `(request)`                     | After response is sent (or connection closed)                           |
| `'route'`       | `(route)`                       | When a route is added                                                   |
| `'start'`       | `()`                            | When `server.start()` completes                                         |
| `'closing'`     | `()`                            | When `server.stop()` begins (requests rejected, connections still open) |
| `'stop'`        | `()`                            | When `server.stop()` completes                                          |

```javascript
// Log event -- tags is { [tag]: true } for O(1) lookup
server.events.on('log', (event, tags) => {

    if (tags.error) {
        console.log(`Server error: ${event.error ? event.error.message : 'unknown'}`);
    }
});

// Request event -- filter by channel
server.events.on({ name: 'request', channels: 'error' }, (request, event, tags) => {

    console.log(`Request ${event.request} failed`);
});

// Response event
server.events.on('response', (request) => {

    console.log(`Response sent for request: ${request.info.id}`);
});
```


#### `server.info`


| Access    | Type     |
| --------- | -------- |
| read only | `object` |

Server connection information:

| Property   | Type     | Description                                                                    |
| ---------- | -------- | ------------------------------------------------------------------------------ |
| `id`       | `string` | Unique identifier: `'{hostname}:{pid}:{now base36}'`                           |
| `created`  | `number` | Server creation timestamp                                                      |
| `started`  | `number` | Server start timestamp (`0` when stopped)                                      |
| `port`     | `number` | Configured port before start; actual port after start (when configured as `0`) |
| `host`     | `string` | The `host` configuration value                                                 |
| `address`  | `string` | Active IP address after start. `undefined` until started or with non-TCP ports |
| `protocol` | `string` | `'http'`, `'https'`, or `'socket'`                                             |
| `uri`      | `string` | Full connection string, e.g., `'http://example.com:8080'`                      |


#### `server.listener`


| Access    | Type          |
| --------- | ------------- |
| read only | `http.Server` |

The underlying node HTTP server object. Useful for integrating with libraries like Socket.io.

```javascript
const SocketIO = require('socket.io');
const io = SocketIO.listen(server.listener);
```


#### `server.load`


| Access    | Type     |
| --------- | -------- |
| read only | `object` |

Current process load metrics (only populated when `load.sampleInterval` is enabled):

| Property               | Description                          |
| ---------------------- | ------------------------------------ |
| `eventLoopDelay`       | Event loop delay in milliseconds     |
| `eventLoopUtilization` | Current event loop utilization value |
| `heapUsed`             | V8 heap usage                        |
| `rss`                  | RSS memory usage                     |


#### `server.methods`


| Access    | Type     |
| --------- | -------- |
| read only | `object` |

Server methods registered via `server.method()`. Each method name is an object property. Methods can use built-in caching and are shared across handlers.

```javascript
server.method('add', (a, b) => (a + b));
server.methods.add(1, 2);  // 3
```


#### `server.mime`


| Access    | Type                   |
| --------- | ---------------------- |
| read only | mimos public interface |

The MIME database. Modify only through the `mime` server option, not directly.

```javascript
server.mime.path('code.js').type;   // 'application/javascript'
```


#### `server.plugins`


| Access       | Type     |
| ------------ | -------- |
| read / write | `object` |

Values exposed by registered plugins. Each key is a plugin name, values are set via `server.expose()` or directly on `server.plugins[name]`.

```javascript
exports.plugin = {
    name: 'example',
    register: function (server, options) {

        server.expose('key', 'value');
        server.plugins.example.other = 'other';
    }
};
```


#### `server.realm`


| Access    | Type     |
| --------- | -------- |
| read only | `object` |

Sandboxed server settings specific to each plugin or auth strategy registration. Each plugin receives its own realm.

| Property                    | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `modifiers.route.prefix`    | Route path prefix for `server.route()` calls                       |
| `modifiers.route.vhost`     | Virtual host settings for `server.route()` calls                   |
| `parent`                    | Parent server realm, or `null` for root                            |
| `plugin`                    | Active plugin name (empty string at root)                          |
| `pluginOptions`             | Plugin options passed at registration                              |
| `plugins`                   | Plugin-specific state: `plugins[name]` can be directly manipulated |
| `settings.files.relativeTo` | File path override                                                 |
| `settings.bind`             | Bind context override                                              |

The realm object is read-only except for `plugins`, which each plugin can manipulate under its own key.


#### `server.registrations`


| Access    | Type     |
| --------- | -------- |
| read only | `object` |

Currently registered plugins. Each key is a plugin name, value is an object with:

| Property  | Description                                   |
| --------- | --------------------------------------------- |
| `version` | Plugin version                                |
| `name`    | Plugin name                                   |
| `options` | Options passed during registration (optional) |


#### `server.settings`


| Access    | Type     |
| --------- | -------- |
| read only | `object` |

The server configuration object with defaults applied. Reflects the options passed to the constructor.

```javascript
const server = Hapi.server({ app: { key: 'value' } });
server.settings.app;  // { key: 'value' }
```


#### `server.states`


| Access    | Type                       |
| --------- | -------------------------- |
| read only | statehood public interface |

The server cookies manager.

| Property                 | Description                                             |
| ------------------------ | ------------------------------------------------------- |
| `server.states.settings` | Cookie manager settings based on `server.options.state` |
| `server.states.cookies`  | Object of cookie configurations keyed by cookie name    |
| `server.states.names`    | Array of all configured cookie names                    |


#### `server.type`


| Access    | Type     |
| --------- | -------- |
| read only | `string` |

The listener type:
- `'socket'` -- UNIX domain socket or Windows named pipe.
- `'tcp'` -- HTTP listener.


#### `server.version`


| Access    | Type     |
| --------- | -------- |
| read only | `string` |

The hapi module version number.

```javascript
console.log(server.version);  // e.g., '21.4.4'
```


### Quick Example: Full Server Setup


```javascript
const Hapi = require('@hapi/hapi');

const server = Hapi.server({
    port: 3000,
    host: 'localhost',
    debug: { request: ['error', 'implementation'] },
    routes: {
        cors: true,
        validate: {
            failAction: 'log'
        }
    },
    router: {
        stripTrailingSlash: true,
        isCaseSensitive: false
    },
    state: {
        strictHeader: true,
        isSecure: false,        // set true in production
        isHttpOnly: true,
        isSameSite: 'Lax'
    },
    app: {
        env: 'development'
    }
});

const init = async () => {

    await server.start();
    console.log('Server running on %s', server.info.uri);
};

init();
```

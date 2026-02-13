## hapi Server Cache Reference


### server.cache(options)


Provisions a cache segment within the server cache facility. Returns a **catbox** policy object with `get()`, `set()`, and `drop()` methods.

```js
    const cache = server.cache({
        segment: 'countries',
        expiresIn: 60 * 60 * 1000
    });

    await cache.set('norway', { capital: 'oslo' });
    const value = await cache.get('norway');
```


### Cache Options


| Option                     | Type                        | Default       | Description                                                                                                                                                                     |
| -------------------------- | --------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expiresIn`                | `number`                    | --            | Relative expiration in milliseconds since the item was saved. Cannot be used with `expiresAt`.                                                                                  |
| `expiresAt`                | `string`                    | --            | Time of day in `'HH:MM'` format (24h, local time) when all records expire. Cannot be used with `expiresIn`.                                                                     |
| `generateFunc`             | `async function(id, flags)` | --            | Function to generate a new cache item when `get()` misses. `flags.ttl` can be set to `0` to skip storing in cache.                                                              |
| `generateTimeout`          | `number \| false`           | --            | **Required** if `generateFunc` is present. Milliseconds to wait before returning a timeout error. Set to `false` to disable timeouts (warning: `get()` calls may hang forever). |
| `staleIn`                  | `number`                    | --            | Milliseconds before a cached item is considered stale and `generateFunc` is called to regenerate. Must be less than `expiresIn`.                                                |
| `staleTimeout`             | `number`                    | --            | Milliseconds to wait before checking if an item is stale.                                                                                                                       |
| `dropOnError`              | `boolean`                   | `true`        | If `true`, errors or timeouts in `generateFunc` evict the stale value from cache.                                                                                               |
| `generateOnReadError`      | `boolean`                   | `true`        | If `false`, upstream cache read errors stop `get()` from calling `generateFunc` and pass back the error instead.                                                                |
| `generateIgnoreWriteError` | `boolean`                   | `true`        | If `false`, upstream cache write errors are passed back with the generated value.                                                                                               |
| `pendingGenerateTimeout`   | `number`                    | `0`           | Milliseconds during an in-progress `generateFunc` call before allowing another concurrent call for the same id.                                                                 |
| `cache`                    | `string`                    | default cache | Name of the cache engine (configured in server options or via `server.cache.provision()`).                                                                                      |
| `segment`                  | `string`                    | auto          | Isolation namespace within the cache partition. Defaults to `'!pluginName'` inside plugins, `'#methodName'` inside server methods. **Required** when called outside a plugin.   |
| `shared`                   | `boolean`                   | `false`       | If `true`, allows multiple cache provisions to share the same segment.                                                                                                          |


### Using generateFunc (Lazy Cache)


The most common pattern: automatically generate and cache values on miss.

```js
    const userCache = server.cache({
        segment: 'users',
        expiresIn: 30 * 60 * 1000,           // 30 minutes
        staleIn: 15 * 60 * 1000,             // 15 minutes
        staleTimeout: 200,                    // 200ms grace before using stale
        generateTimeout: 5000,                // 5s timeout for generation
        generateFunc: async (id, flags) => {

            const user = await db.users.findById(id);
            if (!user) {
                flags.ttl = 0;               // Don't cache misses
            }

            return user;
        }
    });

    // Usage -- automatically calls generateFunc on miss
    const user = await userCache.get('user-123');
```

**Stale refresh behavior:** When `staleIn` and `staleTimeout` are configured, stale items are served immediately while `generateFunc` runs in the background. If `generateFunc` completes within `staleTimeout`, the fresh value is returned instead.


### server.cache.provision(options)


Provisions a new cache engine at runtime. Uses the same options as the server `cache` configuration.

```js
    const Hapi = require('@hapi/hapi');

    const server = Hapi.server({ port: 80 });
    await server.initialize();

    // Add a named cache engine after initialization
    await server.cache.provision({
        provider: require('@hapi/catbox-memory'),
        name: 'my-cache'
    });

    // Use the named cache
    const cache = server.cache({
        cache: 'my-cache',
        segment: 'sessions',
        expiresIn: 60 * 60 * 1000
    });
```

**Gotchas:**
- If the server is already initialized or started, the provisioned cache is automatically started to match the server state.
- The `name` field is how you reference this cache engine in `server.cache({ cache: 'name' })`.
- The default cache (no name) uses `@hapi/catbox-memory`.


### catbox Integration Overview


hapi's caching layer is built on **catbox**, which provides a unified API over multiple storage backends.

**Common catbox providers:**

| Package                  | Backend                     |
| ------------------------ | --------------------------- |
| `@hapi/catbox-memory`    | In-process memory (default) |
| `@hapi/catbox-redis`     | Redis                       |
| `@hapi/catbox-memcached` | Memcached                   |

**Configuring at server creation:**

```js
    const server = Hapi.server({
        port: 80,
        cache: [
            {
                name: 'redis-cache',
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

    // Then use the named cache
    const cache = server.cache({
        cache: 'redis-cache',
        segment: 'users',
        expiresIn: 60 * 1000,
        generateTimeout: 2000,
        generateFunc: async (id) => {

            return await fetchUser(id);
        }
    });
```

**catbox policy methods (returned by server.cache()):**

| Method                | Signature                          | Description                                                        |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `get(id)`             | `await cache.get(key)`             | Retrieve cached value. Calls `generateFunc` on miss if configured. |
| `set(id, value, ttl)` | `await cache.set(key, value, ttl)` | Store a value. `ttl` is optional (uses policy default).            |
| `drop(id)`            | `await cache.drop(key)`            | Remove a value from cache.                                         |
| `stats`               | `cache.stats`                      | Object with cache statistics (hits, misses, etc.).                 |

## @hapi/catbox-memory Engine Reference


In-process memory cache adapter for catbox. This is the **default cache engine** used by hapi when no other provider is configured. It stores values in a `Map`, serializes non-Buffer values via `JSON.stringify`, and runs a single cleanup timer to evict expired entries.

Not designed for sharing cache state between multiple processes (e.g. cluster workers). For multi-process caching, use `@hapi/catbox-redis` or `@hapi/catbox-memcached`.


### Integration with hapi


catbox-memory is the implicit default. A bare `Hapi.server()` call provisions a catbox-memory engine automatically with partition `'hapi-cache'` (`lib/server.js`). You never need to require it unless you want a **named** cache or custom options.

**Default (implicit) -- no configuration needed:**

    const server = Hapi.server({ port: 3000 });

    // The default cache already uses catbox-memory
    const cache = server.cache({
        segment: 'sessions',
        expiresIn: 60 * 60 * 1000
    });

**Named cache with custom options:**

    const server = Hapi.server({
        port: 3000,
        cache: [
            {
                name: 'my-memory-cache',
                provider: {
                    constructor: require('@hapi/catbox-memory'),
                    options: {
                        maxByteSize: 50 * 1024 * 1024,
                        minCleanupIntervalMsec: 5000
                    }
                }
            }
        ]
    });

    const cache = server.cache({
        cache: 'my-memory-cache',
        segment: 'tokens',
        expiresIn: 10 * 60 * 1000
    });

**Runtime provisioning via `server.cache.provision()`:**

    await server.cache.provision({
        provider: require('@hapi/catbox-memory'),
        name: 'runtime-cache'
    });

See [server cache](cache.md) for full details on `server.cache()` and `server.cache.provision()`.


### Constructor Options


`new CatboxMemory.Engine(options)` -- (`lib/index.js:22-33`)

| Option | Type | Default | Description |
|---|---|---|---|
| `maxByteSize` | `number` | `104857600` | Upper limit in bytes for total cache size. Once reached, new `set()` calls throw until entries expire. Set to `0` to disable the limit. |
| `minCleanupIntervalMsec` | `number` | `1000` | Minimum milliseconds between automatic cleanup sweeps. The actual interval is `Math.max(minCleanupIntervalMsec, shortest TTL)`. |
| `cloneBuffersOnGet` | `boolean` | `false` | When `false`, `get()` returns the same Buffer reference from the internal cache (mutations affect the cache). When `true`, a copy is returned each time. |

The `allowMixedContent` option is no longer supported and will throw if provided (`lib/index.js:25`).


### Engine Methods


These are the catbox engine interface methods. You typically interact with them indirectly through the catbox policy returned by `server.cache()`. Direct engine access is available via `policy.client.connection`.

| Method | Description |
|---|---|
| `start()` | Initializes the internal `Map`. Safe to call multiple times; subsequent calls are no-ops. (`lib/index.js:36-42`) |
| `stop()` | Clears the cache `Map`, resets `byteSize` to `0`, and cancels the cleanup timer. (`lib/index.js:85-93`) |
| `isReady()` | Returns `true` if `start()` has been called and `stop()` has not. Checks `!!this.cache`. (`lib/index.js:95-98`) |
| `get(key)` | Returns `{ item, stored, ttl }` or `null`. Lazily evicts expired entries on read. (`lib/index.js:113-159`) |
| `set(key, value, ttl)` | Stores a value. Throws `'Cache size limit reached'` if `maxByteSize` would be exceeded. (`lib/index.js:161-189`) |
| `drop(key)` | Removes a single entry and decrements `byteSize`. Silent if segment or key does not exist. (`lib/index.js:191-205`) |
| `validateSegmentName(name)` | Throws if `name` is empty or contains a null character (`\u0000`). (`lib/index.js:100-111`) |

Keys follow the catbox format: `{ segment: string, id: string }`.


### Value Serialization


catbox-memory serializes values differently based on type (`lib/index.js:214-228`):

- **Buffer values** are copied via `Buffer.alloc()` + `.copy()` on `set()`. On `get()`, the same buffer reference is returned unless `cloneBuffersOnGet` is `true`.
- **All other values** are stored as `JSON.stringify(value)` and parsed back with `JSON.parse()` on `get()`. This prevents mutations to the original object from affecting the cache, but means the value must be JSON-serializable.

Circular references in non-Buffer values cause `set()` to throw a `TypeError` from `JSON.stringify`.


### Byte Size Tracking


Every cache entry tracks its approximate byte size (`lib/index.js:209-228`):

    byteSize = 144 + Buffer.byteLength(serializedValue)
             + Buffer.byteLength(key.segment)
             + Buffer.byteLength(key.id)

The `144` byte overhead is a fixed approximation for the entry metadata (stored timestamp, ttl, byte size fields, Map entry overhead). The total `byteSize` across all entries is tracked on the engine instance and compared against `maxByteSize` on every `set()`.

When replacing an existing key, the old entry's byte size is subtracted before the new limit check (`lib/index.js:176-177`).


### Cleanup Timer


catbox-memory uses a single `setTimeout`-based cleanup timer (`lib/index.js:44-83`):

1. Every `set()` call schedules a cleanup for when the stored item's TTL expires.
2. The actual timeout is clamped to `Math.max(minCleanupIntervalMsec, ttl)` and capped at `2^31 - 1` ms (~24.8 days).
3. When the timer fires, it iterates all segments and entries, evicting expired ones, then reschedules for the next soonest expiration.
4. If a new `set()` call has a shorter TTL than the already-scheduled cleanup, the timer is rescheduled earlier.
5. `stop()` cancels the timer.

Expired entries are also evicted lazily during `get()` (`lib/index.js:129-132`), so reads never return stale data even if the timer has not yet fired.


### TypeScript


catbox-memory ships type declarations (`lib/index.d.ts`). The `Engine` class implements `ClientApi<T>` from `@hapi/catbox`:

    import { Engine } from '@hapi/catbox-memory';

    const engine = new Engine({ maxByteSize: 50 * 1024 * 1024 });

The `Engine.Options` interface extends `ClientOptions` from catbox with the three memory-specific fields (`maxByteSize`, `minCleanupIntervalMsec`, `cloneBuffersOnGet`).


### Gotchas


- **Memory limit errors are thrown, not swallowed.** When `maxByteSize` is reached, `set()` throws a Boom error. If using `generateFunc` in a catbox policy, this surfaces as a persist error on the policy `events` emitter and may cause the stale value to be dropped (depending on `dropOnError`).
- **JSON serialization round-trip.** Non-Buffer values go through `JSON.stringify` / `JSON.parse`. This means `Date` objects become strings, `undefined` values in objects are dropped, prototype chains are lost, and `BigInt` values throw. Design cached values to be plain JSON-safe objects.
- **Buffer mutation on get.** With the default `cloneBuffersOnGet: false`, mutating a Buffer returned by `get()` mutates the cached copy. Subsequent `get()` calls return the mutated value. Enable `cloneBuffersOnGet` if handlers modify returned buffers.
- **No cross-process sharing.** Each process maintains its own independent cache. In cluster deployments, cache misses are per-worker. Use `@hapi/catbox-redis` for shared caching.
- **Byte size is approximate.** The 144-byte per-entry overhead is a rough estimate. Do not rely on `maxByteSize` for precise memory accounting.
- **start() is idempotent but stop() is destructive.** Calling `start()` twice is safe (second call is a no-op). Calling `stop()` clears all cached data immediately and cannot be recovered.
- **Segment name restrictions.** Segment names cannot be empty or contain null characters. hapi auto-generates segment names as `'!pluginName'` for plugins and `'#methodName'` for [server methods](methods.md), so this rarely matters in practice.
- **maxByteSize of 0 disables the limit entirely** -- it does not mean "zero bytes allowed." (`lib/index.js:180-181`)

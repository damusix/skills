## @hapi/catbox-fs Engine Reference


Filesystem-based cache adapter for catbox. Stores cached values on the local filesystem, making the cache **persistent across process restarts** unlike the default in-memory adapter. Values are serialized with `JSON.stringify` (or copied for Buffers) and written to disk, with a cleanup timer to evict expired entries.

Best suited for single-server deployments where cache persistence is needed without external infrastructure. Not designed for sharing cache state between multiple servers. For distributed caching, use `@hapi/catbox-redis` or `@hapi/catbox-memcached`.


### Integration with hapi


catbox-fs must be explicitly configured as it is not the default cache engine. You provide it as a named or default cache via the server `cache` option.

**Named cache configuration:**

    const server = Hapi.server({
        port: 3000,
        cache: [
            {
                name: 'fs-cache',
                provider: {
                    constructor: require('@hapi/catbox-fs'),
                    options: {
                        maxByteSize: 50 * 1024 * 1024,
                        minCleanupIntervalMsec: 5000
                    }
                }
            }
        ]
    });

    const cache = server.cache({
        cache: 'fs-cache',
        segment: 'tokens',
        expiresIn: 10 * 60 * 1000
    });

**Override the default cache engine:**

    const server = Hapi.server({
        port: 3000,
        cache: [
            {
                provider: {
                    constructor: require('@hapi/catbox-fs'),
                    options: {
                        maxByteSize: 100 * 1024 * 1024
                    }
                }
            }
        ]
    });

    const cache = server.cache({
        segment: 'sessions',
        expiresIn: 60 * 60 * 1000
    });

**Runtime provisioning via `server.cache.provision()`:**

    await server.cache.provision({
        provider: require('@hapi/catbox-fs'),
        name: 'runtime-fs-cache'
    });

See [server cache](cache.md) for full details on `server.cache()` and `server.cache.provision()`.


### Constructor Options


`new CatboxFs.Engine(options)` -- (`lib/index.js:22-33`)

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
| `start()` | Initializes the internal cache store. Safe to call multiple times; subsequent calls are no-ops. (`lib/index.js:36-42`) |
| `stop()` | Clears the cache, resets `byteSize` to `0`, and cancels the cleanup timer. (`lib/index.js:85-93`) |
| `isReady()` | Returns `true` if `start()` has been called and `stop()` has not. Checks `!!this.cache`. (`lib/index.js:95-98`) |
| `get(key)` | Returns `{ item, stored, ttl }` or `null`. Lazily evicts expired entries on read. (`lib/index.js:113-159`) |
| `set(key, value, ttl)` | Stores a value. Throws `'Cache size limit reached'` if `maxByteSize` would be exceeded. (`lib/index.js:161-189`) |
| `drop(key)` | Removes a single entry and decrements `byteSize`. Silent if segment or key does not exist. (`lib/index.js:191-205`) |
| `validateSegmentName(name)` | Throws if `name` is empty or contains a null character (`\u0000`). (`lib/index.js:100-111`) |

Keys follow the catbox format: `{ segment: string, id: string }`.


### Value Serialization


catbox-fs serializes values differently based on type (`lib/index.js:214-228`):

- **Buffer values** are copied via `Buffer.alloc()` + `.copy()` on `set()`. On `get()`, the same buffer reference is returned unless `cloneBuffersOnGet` is `true`.
- **All other values** are stored as `JSON.stringify(value)` and parsed back with `JSON.parse()` on `get()`. This prevents mutations to the original object from affecting the cache, but means the value must be JSON-serializable.

Circular references in non-Buffer values cause `set()` to throw a `TypeError` from `JSON.stringify`.


### Byte Size Tracking


Every cache entry tracks its approximate byte size (`lib/index.js:209-228`):

    byteSize = 144 + Buffer.byteLength(serializedValue)
             + Buffer.byteLength(key.segment)
             + Buffer.byteLength(key.id)

The `144` byte overhead is a fixed approximation for the entry metadata (stored timestamp, ttl, byte size fields, entry overhead). The total `byteSize` across all entries is tracked on the engine instance and compared against `maxByteSize` on every `set()`.

When replacing an existing key, the old entry's byte size is subtracted before the new limit check (`lib/index.js:176-177`).


### Cleanup Timer


catbox-fs uses a single `setTimeout`-based cleanup timer (`lib/index.js:44-83`):

1. Every `set()` call schedules a cleanup for when the stored item's TTL expires.
2. The actual timeout is clamped to `Math.max(minCleanupIntervalMsec, ttl)` and capped at `2^31 - 1` ms (~24.8 days).
3. When the timer fires, it iterates all segments and entries, evicting expired ones, then reschedules for the next soonest expiration.
4. If a new `set()` call has a shorter TTL than the already-scheduled cleanup, the timer is rescheduled earlier.
5. `stop()` cancels the timer.

Expired entries are also evicted lazily during `get()` (`lib/index.js:129-132`), so reads never return stale data even if the timer has not yet fired.


### TypeScript


catbox-fs ships type declarations (`lib/index.d.ts`). The `Engine` class implements `ClientApi<T>` from `@hapi/catbox`:

    import { Engine } from '@hapi/catbox-fs';

    const engine = new Engine({ maxByteSize: 50 * 1024 * 1024 });

The `Engine.Options` interface extends `ClientOptions` from catbox with the three fs-specific fields (`maxByteSize`, `minCleanupIntervalMsec`, `cloneBuffersOnGet`).


### Gotchas


- **Size limit errors are thrown, not swallowed.** When `maxByteSize` is reached, `set()` throws a Boom error. If using `generateFunc` in a catbox policy, this surfaces as a persist error on the policy `events` emitter and may cause the stale value to be dropped (depending on `dropOnError`).
- **JSON serialization round-trip.** Non-Buffer values go through `JSON.stringify` / `JSON.parse`. This means `Date` objects become strings, `undefined` values in objects are dropped, prototype chains are lost, and `BigInt` values throw. Design cached values to be plain JSON-safe objects.
- **Buffer mutation on get.** With the default `cloneBuffersOnGet: false`, mutating a Buffer returned by `get()` mutates the cached copy. Subsequent `get()` calls return the mutated value. Enable `cloneBuffersOnGet` if handlers modify returned buffers.
- **Single-server only.** Each server maintains its own independent cache. Unlike `@hapi/catbox-redis`, cache state is not shared across multiple servers. Use catbox-redis for distributed caching.
- **Byte size is approximate.** The 144-byte per-entry overhead is a rough estimate. Do not rely on `maxByteSize` for precise storage accounting.
- **start() is idempotent but stop() is destructive.** Calling `start()` twice is safe (second call is a no-op). Calling `stop()` clears all cached data immediately and cannot be recovered.
- **Segment name restrictions.** Segment names cannot be empty or contain null characters. hapi auto-generates segment names as `'!pluginName'` for plugins and `'#methodName'` for [server methods](methods.md), so this rarely matters in practice.
- **maxByteSize of 0 disables the limit entirely** -- it does not mean "zero bytes allowed." (`lib/index.js:180-181`)

## @hapi/catbox-redis Reference


Redis cache adapter for hapi's catbox caching layer. Implements the catbox engine interface using [ioredis](https://github.com/redis/ioredis) as the underlying Redis client. Works with Redis, Dragonfly, and Valkey.

For general caching concepts (policy options, `generateFunc`, stale refresh), see [server cache](cache.md).


### Registering with hapi


catbox-redis is not a hapi plugin. It is configured as a cache provider in the server constructor or via `server.cache.provision()`.

**At server creation:**

    const Hapi = require('@hapi/hapi');
    const CatboxRedis = require('@hapi/catbox-redis');

    const server = Hapi.server({
        port: 3000,
        cache: [
            {
                name: 'my-redis',
                provider: {
                    constructor: CatboxRedis,
                    options: {
                        partition: 'my-app',
                        host: '127.0.0.1',
                        port: 6379
                    }
                }
            }
        ]
    });

**At runtime via provision:**

    await server.cache.provision({
        provider: {
            constructor: require('@hapi/catbox-redis'),
            options: {
                partition: 'my-app',
                host: '127.0.0.1',
                port: 6379
            }
        },
        name: 'my-redis'
    });

Once registered, use the named cache in `server.cache()` or [server methods](methods.md):

    const cache = server.cache({
        cache: 'my-redis',
        segment: 'sessions',
        expiresIn: 60 * 60 * 1000,
        generateTimeout: 2000,
        generateFunc: async (id) => {

            return await fetchSession(id);
        }
    });


### Connection Options


The `Engine` constructor accepts one of three option shapes, validated via joi (`lib/index.js:45-60`).

**Shape 1: Host/port (default)**

| Option       | Type               | Default       | Description                                                                 |
| ------------ | ------------------ | ------------- | --------------------------------------------------------------------------- |
| `host`       | `string`           | `'127.0.0.1'` | Redis server hostname.                                                     |
| `port`       | `number`           | `6379`        | Redis server port.                                                          |
| `partition`  | `string`           | `''`          | Key prefix for namespace isolation. URI-encoded in the final Redis key.     |
| `password`   | `string`           | --            | Redis AUTH password.                                                        |
| `db`         | `string \| number` | --            | Redis database index. Alias: `database`.                                    |
| `tls`        | `object`           | --            | TLS options object passed directly to ioredis.                              |
| `sentinels`  | `array`            | --            | Array of `{ host, port }` sentinel addresses. Requires `sentinelName`.      |
| `sentinelName` | `string`         | --            | Sentinel master name. Alias: `name`. Required when `sentinels` is provided. |

**Shape 2: URL / socket / cluster**

| Option    | Type     | Description                                                         |
| --------- | -------- | ------------------------------------------------------------------- |
| `url`     | `string` | Redis connection URL (e.g. `'redis://user:pass@host:6379/0'`).     |
| `socket`  | `string` | Unix domain socket path.                                            |
| `cluster` | `array`  | Array of `{ host, port }` objects for Redis Cluster mode.           |

These three are mutually exclusive (`lib/index.js:57` -- `.xor('url', 'socket', 'cluster')`). All common options (`partition`, `password`, `db`, `tls`, `sentinels`, `sentinelName`) apply to URL, socket, and cluster shapes as well.

**Shape 3: External client**

| Option      | Type     | Description                                                  |
| ----------- | -------- | ------------------------------------------------------------ |
| `client`    | `object` | A pre-connected ioredis `Redis` or `Cluster` instance.       |
| `partition` | `string` | Key prefix (same as above).                                  |

When `client` is provided, all other connection options are ignored. The engine will **not** disconnect the client on `stop()` -- you manage the client lifecycle yourself (`lib/index.js:139-144`).

Any additional unrecognized options are passed through to ioredis (the schema uses `.unknown()`).


### Connection Modes


#### Single Server

    const server = Hapi.server({
        cache: [{
            name: 'redis',
            provider: {
                constructor: require('@hapi/catbox-redis'),
                options: { host: '127.0.0.1', port: 6379 }
            }
        }]
    });

#### Redis URL

    const server = Hapi.server({
        cache: [{
            name: 'redis',
            provider: {
                constructor: require('@hapi/catbox-redis'),
                options: { url: 'redis://user:secret@redis.example.com:6379/0' }
            }
        }]
    });

#### Unix Socket

    const server = Hapi.server({
        cache: [{
            name: 'redis',
            provider: {
                constructor: require('@hapi/catbox-redis'),
                options: { socket: '/var/run/redis.sock' }
            }
        }]
    });

#### Cluster

Connects using `ioredis.Cluster` (`lib/index.js:96-103`). Provide at least one node:

    const server = Hapi.server({
        cache: [{
            name: 'redis-cluster',
            provider: {
                constructor: require('@hapi/catbox-redis'),
                options: {
                    cluster: [
                        { host: '127.0.0.1', port: 7000 },
                        { host: '127.0.0.1', port: 7001 },
                        { host: '127.0.0.1', port: 7002 }
                    ]
                }
            }
        }]
    });

#### Sentinel

    const server = Hapi.server({
        cache: [{
            name: 'redis-sentinel',
            provider: {
                constructor: require('@hapi/catbox-redis'),
                options: {
                    sentinels: [
                        { host: '127.0.0.1', port: 26379 },
                        { host: '127.0.0.2', port: 26379 }
                    ],
                    sentinelName: 'mymaster'
                }
            }
        }]
    });

#### Pre-Connected Client

    const IoRedis = require('ioredis');
    const redisClient = new IoRedis({ host: '127.0.0.1', port: 6379 });

    const server = Hapi.server({
        cache: [{
            name: 'redis',
            provider: {
                constructor: require('@hapi/catbox-redis'),
                options: { client: redisClient }
            }
        }]
    });


### Engine Interface


catbox-redis implements the catbox engine protocol. These methods are called internally by the catbox `Client` wrapper; you do not call them directly when using hapi's `server.cache()`.

| Method                        | Description                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `start()`                     | Creates the ioredis connection. Skips if already connected or using an external `client`.              |
| `stop()`                      | Disconnects from Redis and sets `client` to `null`. Does **not** disconnect external clients.          |
| `isReady()`                   | Returns `true` when `client.status === 'ready'` (`lib/index.js:152`).                                |
| `validateSegmentName(name)`   | Rejects empty strings and strings containing null characters (`\0`) (`lib/index.js:155-166`).         |
| `get(key)`                    | Retrieves and parses a JSON envelope from Redis. Returns `{ item, stored, ttl }` or `null`.           |
| `set(key, value, ttl)`        | Wraps value in `{ item, stored, ttl }` envelope, serializes to JSON, stores with `PSETEX`.            |
| `drop(key)`                   | Deletes the key from Redis using `DEL`.                                                                |
| `generateKey({ id, segment })` | Builds the Redis key as `partition:segment:id` (each part URI-encoded). Omits `partition:` when empty. |


### Key Format


Redis keys are built by `generateKey()` (`lib/index.js:224-236`):

    [partition:]segment:id

Each component is URI-encoded via `encodeURIComponent()`. When `partition` is empty (the default), the key is `segment:id`.

Examples:

| partition  | segment  | id    | Redis key            |
| ---------- | -------- | ----- | -------------------- |
| `'myapp'`  | `'users'` | `'42'` | `myapp:users:42`    |
| `''`       | `'users'` | `'42'` | `users:42`          |
| `'myapp'`  | `'!plugin'` | `'x'` | `myapp:%21plugin:x` |


### Data Envelope


Values are stored as JSON strings in the format (`lib/index.js:203-207`):

    { "item": <value>, "stored": <timestamp>, "ttl": <ms> }

The `stored` timestamp is `Date.now()` at write time. Redis TTL is set via `PSETEX` (millisecond precision). On read, the envelope is parsed with `@hapi/bourne` (prototype pollution-safe JSON parse).


### TypeScript


The package exports `Engine<T>` and `CatboxRedisOptions` (`lib/index.d.ts`):

    import { Engine } from '@hapi/catbox-redis';
    import type { CatboxRedisOptions } from '@hapi/catbox-redis';

    const engine = new Engine<MyValue>({
        host: '127.0.0.1',
        port: 6379,
        partition: 'my-app'
    });

`CatboxRedisOptions` extends `ClientOptions` from `@hapi/catbox` and adds all Redis-specific fields. The `client` field accepts `ioredis.Redis | ioredis.Cluster`.


### Full hapi Integration Example


    const Hapi = require('@hapi/hapi');
    const CatboxRedis = require('@hapi/catbox-redis');

    const init = async () => {

        const server = Hapi.server({
            port: 3000,
            cache: [{
                name: 'redis',
                provider: {
                    constructor: CatboxRedis,
                    options: {
                        partition: 'my-app',
                        host: '127.0.0.1',
                        port: 6379,
                        password: 'secret',
                        db: 0
                    }
                }
            }]
        });

        // Server method with Redis-backed caching
        server.method('getUser', async (id) => {

            return await db.users.findById(id);
        }, {
            cache: {
                cache: 'redis',
                expiresIn: 30 * 60 * 1000,
                staleIn: 15 * 60 * 1000,
                staleTimeout: 200,
                generateTimeout: 5000
            }
        });

        // Direct policy usage
        const sessionCache = server.cache({
            cache: 'redis',
            segment: 'sessions',
            expiresIn: 24 * 60 * 60 * 1000
        });

        server.route({
            method: 'GET',
            path: '/user/{id}',
            handler: async (request) => {

                return await server.methods.getUser(request.params.id);
            }
        });

        await server.start();
    };

    init();


### Gotchas


- **Partition default is empty string.** Unlike catbox-memory which defaults to `'hapi-cache'`, catbox-redis defaults `partition` to `''` (`lib/index.js:11`). When used through hapi's server `cache` option, hapi sets `partition` to `'hapi-cache'` unless overridden in `provider.options.partition`.
- **External clients are not disconnected on stop.** When you pass a pre-connected `client` in options, calling `stop()` sets the internal reference to `null` but does not call `disconnect()` on your client (`lib/index.js:139-144`). You must manage the client lifecycle yourself.
- **Cluster mode does not use `lazyConnect`.** Single-server and URL/socket modes use `lazyConnect: true` for explicit `connect()` control, but cluster mode sets `lazyConnect` to `false` and waits for the `'ready'` event instead (`lib/index.js:88`).
- **Connection failures on single-server disconnect the client.** If `start()` fails before `this.client` is assigned, the error handler calls `client.disconnect()` to clean up (`lib/index.js:109-113`). Post-connection errors do not disconnect.
- **Values must be JSON-serializable.** The engine uses `JSON.stringify()` on the envelope (`lib/index.js:210`). Circular references or non-serializable values (functions, BigInt) throw.
- **Segment names cannot be empty or contain null characters.** `validateSegmentName()` rejects both cases (`lib/index.js:155-166`). hapi auto-prefixes segments with `'!'` for plugins and `'#'` for server methods.
- **`database` and `sentinelName` are renamed.** The schema renames `database` to `db` and `sentinelName` to `name` before passing options to ioredis (`lib/index.js:38-39`).
- **TTL uses millisecond precision.** The engine uses Redis `PSETEX` (not `SETEX`) for millisecond-accurate expiration (`lib/index.js:212`).

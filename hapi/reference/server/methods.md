## Server Methods


Server methods are reusable functions registered on the server with optional built-in caching. They are available globally via `server.methods` and are the preferred way to share utility logic across route handlers.


### Registering a Method


```typescript
server.method(name, method, [options])
```

| Parameter | Type                        | Description                                                                                                                       |
| --------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | `string`                    | Unique method name. Supports dot-separated nesting (e.g. `'utils.users.get'`).                                                    |
| `method`  | `(...args, [flags]) => any` | The method function. When caching is enabled, receives an extra `flags` parameter (appended automatically, not passed by caller). |
| `options` | `ServerMethodOptions`       | Optional configuration for bind, cache, and key generation.                                                                       |


### Options


| Option        | Type                          | Description                                                                                                                                                                                                                                   |
| ------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bind`        | `object`                      | Context object passed as `this` to the method. Defaults to active context from `server.bind()`. Ignored for arrow functions.                                                                                                                  |
| `cache`       | `ServerMethodCache`           | Catbox cache policy config. Same as `server.cache()` options. `generateTimeout` is **required**. `generateFunc` is **not allowed** (the method itself is the generate function).                                                              |
| `generateKey` | `(...args) => string \| null` | Function to produce a cache key from the method arguments (the `flags` arg is excluded). Auto-generated if all args are `string`, `number`, or `boolean`. **Required** for other argument types. Return `null` to skip caching for that call. |


### Basic Example (with Caching)


```typescript
const add = (a: number, b: number) => {

    return a + b;
};

server.method('sum', add, {
    cache: {
        expiresIn: 2000,
        generateTimeout: 100
    }
});

const result = await server.methods.sum(4, 5);    // 9
```

Auto-key generation works here because both arguments are `number`.


### Custom generateKey


When arguments are objects or arrays, you must provide `generateKey`:

```typescript
const addArray = (array: number[]) => {

    let sum = 0;
    array.forEach((item) => {

        sum += item;
    });

    return sum;
};

server.method('sumArray', addArray, {
    cache: {
        expiresIn: 2000,
        generateTimeout: 100
    },
    generateKey: (array) => array.join(',')
});

const result = await server.methods.sumArray([5, 6]);    // 11
```


### Flags Parameter (Cache TTL Override)


When caching is enabled, the method receives an automatic `flags` parameter as the last argument. Set `flags.ttl = 0` to indicate the result is valid but should not be cached:

```typescript
const getUser = async (id: string, flags: { ttl: number }) => {

    const user = await db.users.get(id);
    if (user.temporary) {
        flags.ttl = 0;    // Valid result, but don't cache it
    }

    return user;
};

server.method('getUser', getUser, {
    cache: {
        expiresIn: 60 * 60 * 1000,
        generateTimeout: 5000
    }
});

// Caller does NOT pass flags — it is injected automatically
const user = await server.methods.getUser('user-123');
```


### Nested Method Names


Dot-separated names create nested objects under `server.methods`:

```typescript
server.method('utils.users.get', async (id: string) => {

    return await db.users.findById(id);
});

// Access via the nested path
const user = await server.methods.utils.users.get('abc');
```


### Array Registration Form


Register multiple methods at once using an object or array of objects:

```typescript
server.method({
    name: 'sum',
    method: (a: number, b: number) => a + b,
    options: {
        cache: {
            expiresIn: 2000,
            generateTimeout: 100
        }
    }
});

// Or as an array
server.method([
    { name: 'add', method: (a: number, b: number) => a + b },
    { name: 'multiply', method: (a: number, b: number) => a * b }
]);
```


### CachedServerMethod — Cache Control


When a method is registered with caching enabled, `server.methods[name]` gains a `.cache` property:

| Property/Method              | Description                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `await .cache.drop(...args)` | Clears the cached value for the given arguments. Pass the same args you would pass to the method. |
| `.cache.stats`               | Object with cache statistics (hits, misses, generates, etc.). See catbox `CacheStatisticsObject`. |

```typescript
server.method('getUser', fetchUser, {
    cache: {
        expiresIn: 60 * 60 * 1000,
        generateTimeout: 2000
    }
});

// Use the method
await server.methods.getUser('user-123');

// Drop a specific cached entry
await server.methods.getUser.cache.drop('user-123');

// Check stats
console.log(server.methods.getUser.cache.stats);
```


### Cache Options Reference


These are the catbox policy options available in the `cache` config:

| Option                   | Type              | Description                                                                                                              |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `expiresIn`              | `number`          | TTL in milliseconds from when the item was saved. Cannot use with `expiresAt`.                                           |
| `expiresAt`              | `string`          | Daily expiration in `'HH:MM'` format (local time). Cannot use with `expiresIn`.                                          |
| `staleIn`                | `number`          | Milliseconds before a cached item is considered stale (triggers background regeneration). Must be less than `expiresIn`. |
| `staleTimeout`           | `number`          | Milliseconds to wait before checking staleness.                                                                          |
| `generateTimeout`        | `number \| false` | **Required.** Milliseconds before a generate call times out. Set `false` to disable (may cause requests to hang).        |
| `dropOnError`            | `boolean`         | If `true`, evict stale value on generate error. Default: `true`.                                                         |
| `pendingGenerateTimeout` | `number`          | Milliseconds before allowing a concurrent generate call for the same key. Default: `0`.                                  |
| `cache`                  | `string`          | Named cache provision (from `server.options.cache`). Defaults to default cache.                                          |
| `segment`                | `string`          | Cache segment name. Defaults to `'#name'` for server methods.                                                            |


### Bind Context


```typescript
server.method('greet', function (name: string) {

    return `${this.greeting}, ${name}!`;
}, {
    bind: { greeting: 'Hello' }
});

await server.methods.greet('World');    // 'Hello, World!'
```

The `bind` option is ignored for arrow functions. If not set, defaults to the active context from `server.bind()`.


### TypeScript: Augmenting ServerMethods


To get typed access to `server.methods`, augment the `ServerMethods` interface:

```typescript
import { CachedServerMethod } from '@hapi/hapi';

declare module '@hapi/hapi' {
    interface ServerMethods {
        getUser: CachedServerMethod<(id: string) => Promise<User>>;
        utils: {
            format: (input: string) => string;
        };
    }
}

// Now server.methods is fully typed
const user = await server.methods.getUser('abc');
await server.methods.getUser.cache.drop('abc');
const formatted = server.methods.utils.format('test');
```

Key types from `lib/types/server/methods.d.ts`:

| Type                              | Description                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ServerMethod`                    | Generic method signature `(...args: any[]) => any`.                                                    |
| `CachedServerMethod<T>`           | Intersection of `T` with `{ cache?: { drop(...args): Promise<void>; stats: CacheStatisticsObject } }`. |
| `ServerMethodOptions`             | Options interface with `bind`, `cache`, and `generateKey`.                                             |
| `ServerMethodCache`               | Extends catbox `PolicyOptions` with required `generateTimeout` and optional `cache`/`segment`.         |
| `ServerMethodConfigurationObject` | Object form with `name`, `method`, `options` for array registration.                                   |
| `ServerMethods`                   | Augmentable interface extending `BaseServerMethods`.                                                   |


### Gotchas


- Methods **must** be registered before the server is started if they use caching — cache initialization happens during `server.initialize()`.
- `generateTimeout` is required when using `cache`. Without it, registration throws.
- The `flags` argument is appended automatically by hapi when caching is enabled. Do **not** pass it as a caller argument.
- Auto-key generation only works for `string`, `number`, and `boolean` args. For objects, arrays, or mixed types, always provide `generateKey`.
- `generateKey` returning `null` means the result will not be cached for that particular set of arguments.
- Nested method names (dot-separated) create intermediate objects on `server.methods`. Avoid name collisions (e.g. registering both `'utils'` and `'utils.get'`).

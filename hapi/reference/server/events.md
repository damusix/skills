## Server Events


hapi provides a robust event system built on **podium**. It supports custom application events, built-in server lifecycle events, channel filtering, tag-based subscriptions, and event gauging.


### server.log(tags, [data, [timestamp]])


Emits a server-level log event (not tied to a specific request). Triggers the `'log'` event on `server.events`.

| Parameter   | Type                              | Description                                                                                                                       |
| ----------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tags`      | `string \| string[]`              | Tag(s) identifying the event. Used instead of log levels (e.g. `['error', 'database']`). Internal hapi logs include `'hapi'` tag. |
| `data`      | `string \| object \| (() => any)` | Message or data payload. If a function, it is called lazily only if listeners exist.                                              |
| `timestamp` | `number`                          | Millisecond timestamp. Defaults to `Date.now()`.                                                                                  |

```typescript
server.log(['info', 'startup'], 'Server initialized');
server.log('error', new Error('Something broke'));

// Lazy data — function only called if there are listeners
server.log('debug', () => expensiveDebugInfo());
```


### Registering Custom Events — server.event(events)


Events **must** be registered before they can be emitted or subscribed to. This prevents typos in event names from silently failing.

```typescript
// Simple string
server.event('myEvent');

// Options object
server.event({
    name: 'user-action',
    channels: ['web', 'api'],
    clone: true,
    shared: false
});

// Array of mixed
server.event([
    'simple-event',
    { name: 'complex-event', spread: true, tags: true }
]);
```

**Event registration options:**

| Option     | Type                 | Default    | Description                                                                                       |
| ---------- | -------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `name`     | `string`             | (required) | The event name.                                                                                   |
| `channels` | `string \| string[]` | none       | Allowed channels. If set, emits must use one of these channels.                                   |
| `clone`    | `boolean`            | `false`    | Clone data before passing to listeners.                                                           |
| `spread`   | `boolean`            | `false`    | If `true`, data must be an array and each element is passed as a separate argument.               |
| `tags`     | `boolean`            | `false`    | If `true` and emit includes tags, a tags object `{ tagName: true }` is appended to listener args. |
| `shared`   | `boolean`            | `false`    | If `true`, duplicate registrations are silently ignored instead of throwing.                      |


### Emitting Events — server.events.emit(criteria, data)


Fires an event to all subscribed listeners. Does not wait for listeners to complete.

```typescript
// Simple emit
server.events.emit('myEvent', { key: 'value' });

// With channel and tags
server.events.emit(
    { name: 'user-action', channel: 'web', tags: ['admin', 'write'] },
    { userId: '123', action: 'delete' }
);

// Lazy data — function only invoked if listeners exist
server.events.emit('myEvent', () => computeExpensivePayload());
```

**Criteria object:**

| Property  | Type                 | Description                     |
| --------- | -------------------- | ------------------------------- |
| `name`    | `string`             | (required) Event name.          |
| `channel` | `string`             | Channel to emit on.             |
| `tags`    | `string \| string[]` | Tags attached to this emission. |


### Subscribing — server.events.on(criteria, listener, context)


Subscribe to all occurrences of an event.

```typescript
// Simple string subscription
server.events.on('myEvent', (data) => {

    console.log(data);
});

// Criteria object with filtering
server.events.on({
    name: 'user-action',
    channels: 'web',
    filter: { tags: ['admin'], all: true },
    clone: true,
    count: 10    // Auto-unsubscribe after 10 calls
}, (data) => {

    console.log('Admin web action:', data);
});

// With context binding
server.events.on('myEvent', function (data) {

    console.log(this.prefix, data);
}, { prefix: 'EVENT:' });
```

**Subscription criteria object:**

| Property   | Type                                   | Default       | Description                                                                                                               |
| ---------- | -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `name`     | `string`                               | (required)    | Event name.                                                                                                               |
| `channels` | `string \| string[]`                   | none          | Only receive events emitted on these channels. Events emitted without a channel are excluded when channels filter is set. |
| `clone`    | `boolean`                              | event default | Clone data before passing to this listener.                                                                               |
| `count`    | `number`                               | unlimited     | Auto-remove subscription after N calls. `count: 1` is equivalent to `once()`.                                             |
| `filter`   | `string \| string[] \| { tags, all? }` | none          | Only receive events with matching tags. `all: true` requires all tags to match. Default is any-match.                     |
| `spread`   | `boolean`                              | event default | Spread array data as separate arguments.                                                                                  |
| `tags`     | `boolean`                              | event default | Append a `{ tag: true }` object as the last listener argument.                                                            |


### Once — server.events.once(criteria, [listener, context])


Subscribe to a single occurrence. Two forms:

**Callback form:**

```typescript
server.events.once('myEvent', (data) => {

    console.log('First and only:', data);
});
```

**Await form** (no listener argument):

```typescript
const pending = server.events.once('myEvent');
server.events.emit('myEvent', 'hello');
const data = await pending;    // 'hello'
```


### Gauge — await server.events.gauge(criteria, data)


Works identically to `emit()` but returns results from all listeners via `Promise.allSettled()`:

```typescript
server.event('validate');

server.events.on('validate', (data) => {

    if (!data.name) {
        throw new Error('Name required');
    }

    return 'ok';
});

const results = await server.events.gauge('validate', { name: '' });
// [{ status: 'rejected', reason: Error('Name required') }]

const results2 = await server.events.gauge('validate', { name: 'test' });
// [{ status: 'fulfilled', value: 'ok' }]
```

Each result item is `{ status: 'fulfilled', value }` or `{ status: 'rejected', reason }`. System errors like `TypeError` are not handled specially.


### Built-in Server Events


#### `'log'` Event


Emitted for server-level logs (via `server.log()` and internal framework events).

**Handler signature:** `function(event, tags)`

| Argument          | Type                      | Description                                                          |
| ----------------- | ------------------------- | -------------------------------------------------------------------- |
| `event.timestamp` | `number`                  | Event timestamp.                                                     |
| `event.tags`      | `string[]`                | Tags identifying the event.                                          |
| `event.channel`   | `'internal' \| 'app'`     | `'internal'` for framework events, `'app'` for `server.log()` calls. |
| `event.data`      | `any`                     | Event data (when not an error).                                      |
| `event.error`     | `Error`                   | Error object (mutually exclusive with `data`).                       |
| `tags`            | `{ [key: string]: true }` | Tags as a boolean hash for quick lookup.                             |

```typescript
server.events.on('log', (event, tags) => {

    if (tags.error) {
        console.log(`Server error: ${event.error ? event.error.message : 'unknown'}`);
    }
});
```

**Internal log events** (identified by tags):
- `load` — server rejected request due to high load
- `connection` `client` `error` — HTTP/HTTPS `clientError` event


#### `'request'` Event


Emitted for request-level events (via `request.log()` and internal framework events).

**Handler signature:** `function(request, event, tags)`

| Argument          | Type                             | Description                                                                                   |
| ----------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `request`         | `Request`                        | The request object.                                                                           |
| `event.timestamp` | `number`                         | Event timestamp.                                                                              |
| `event.tags`      | `string[]`                       | Tags identifying the event.                                                                   |
| `event.channel`   | `'app' \| 'error' \| 'internal'` | `'app'` from `request.log()`, `'error'` for 500 responses, `'internal'` for framework events. |
| `event.request`   | `string`                         | The request identifier.                                                                       |
| `event.data`      | `any`                            | Event data (mutually exclusive with `error`).                                                 |
| `event.error`     | `Error`                          | Error object (mutually exclusive with `data`).                                                |
| `tags`            | `{ [key: string]: true }`        | Tags as boolean hash.                                                                         |

```typescript
// All request events
server.events.on('request', (request, event, tags) => {

    if (tags.error) {
        console.log(`Request ${event.request} error: ${event.error?.message}`);
    }
});

// Only error channel
server.events.on({ name: 'request', channels: 'error' }, (request, event, tags) => {

    console.log(`Request ${event.request} failed`);
});

// Only app-level request logs
server.events.on({ name: 'request', channels: 'app' }, (request, event, tags) => {

    console.log('App log:', event.data);
});
```

**Internal request events** (common tags):

| Tags                                          | Description                                                   |
| --------------------------------------------- | ------------------------------------------------------------- |
| `handler` `error`                             | Route handler returned an error.                              |
| `pre` `error`                                 | Pre-method returned an error.                                 |
| `internal` `error`                            | HTTP 500 assigned to request.                                 |
| `auth` `unauthenticated` `error` `{strategy}` | Auth strategy failed (invalid credentials).                   |
| `auth` `scope` `error`                        | Authenticated but insufficient scope.                         |
| `validation` `error` `{input}`                | Input validation failed (only when failAction is `'log'`).    |
| `validation` `response` `error`               | Response validation failed (only when failAction is `'log'`). |
| `payload` `error`                             | Payload processing failed.                                    |
| `state` `error`                               | Invalid cookie(s) received.                                   |
| `request` `error` `close`                     | Client closed connection prematurely.                         |
| `response` `error`                            | Failed writing response to client.                            |


#### `'response'` Event


Emitted after the response is sent (or connection closed without response).

**Handler signature:** `function(request)`

```typescript
server.events.on('response', (request) => {

    console.log(`${request.method} ${request.path} -> ${request.response?.statusCode}`);
});
```

A single event is emitted per request. If the client disconnected before a response, `request.response` is `null`.


#### `'route'` Event


Emitted when a route is added via `server.route()`.

**Handler signature:** `function(route)`

```typescript
server.events.on('route', (route) => {

    console.log(`Route added: ${route.method} ${route.path}`);
});
```

The `route` object must not be modified.


#### `'cachePolicy'` Event


Emitted when a cache policy is created via `server.cache()` or a cached `server.method()`.

**Handler signature:** `function(cachePolicy, cache, segment)`

```typescript
server.events.on('cachePolicy', (cachePolicy, cache, segment) => {

    console.log(`Cache policy: ${cache ?? 'default'} / ${segment}`);
});
```


#### `'start'` Event


Emitted when the server starts via `server.start()`.

```typescript
server.events.on('start', () => {

    console.log('Server started');
});
```


#### `'closing'` Event


Emitted when `server.stop()` is called, after incoming requests are rejected but before active connections close. Fires before the `'stop'` event.

```typescript
server.events.on('closing', () => {

    console.log('Server closing — no new requests accepted');
});
```


#### `'stop'` Event


Emitted after the server fully stops via `server.stop()`.

```typescript
server.events.on('stop', () => {

    console.log('Server stopped');
});
```


### Event Lifecycle Order


1. `server.start()` triggers `'start'`
2. Routes serve requests, emitting `'request'` and `'response'` events
3. `server.stop()` triggers `'closing'`, then `'stop'` after connections drain


### Other Event Methods


| Method                                         | Description                                                |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `server.events.removeListener(name, listener)` | Remove a specific listener.                                |
| `server.events.removeAllListeners(name)`       | Remove all listeners for an event.                         |
| `server.events.hasListeners(name)`             | Returns `boolean` — whether listeners exist for the event. |


### TypeScript Event Types


Key types from `lib/types/server/events.d.ts`:

| Type                            | Description                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ServerEventsApplication`       | Union type for `server.event()` argument: `string \| ServerEventsApplicationObject \| Podium`.   |
| `ServerEventsApplicationObject` | Event registration config: `{ name, channels?, clone?, spread?, tags?, shared? }`.               |
| `ServerEventCriteria<T>`        | Subscription criteria object: `{ name: T, channels?, clone?, count?, filter?, spread?, tags? }`. |
| `LogEvent`                      | Log event object with `timestamp`, `tags`, `channel`, `data`, `error`.                           |
| `RequestEvent`                  | Request event object (same shape, `channel` includes `'error'`).                                 |
| `LogEventHandler`               | `(event: LogEvent, tags: { [key: string]: true }) => void`                                       |
| `RequestEventHandler`           | `(request: Request, event: RequestEvent, tags: { [key: string]: true }) => void`                 |
| `ResponseEventHandler`          | `(request: Request) => void`                                                                     |
| `RouteEventHandler`             | `(route: RequestRoute) => void`                                                                  |
| `StartEventHandler`             | `() => void`                                                                                     |
| `StopEventHandler`              | `() => void`                                                                                     |
| `ServerEvents`                  | Extends Podium with typed overloads for `on()` and `once()` for each built-in event.             |


### Gotchas


- Events **must** be registered with `server.event()` before calling `emit()`, `on()`, or `once()` on them. Unregistered event names throw.
- `server.events.emit()` does **not** wait for listeners. Use `server.events.gauge()` if you need to collect results or wait for completion.
- The `'request'` event has three channels: `'app'`, `'error'`, and `'internal'`. Without a channels filter, you receive all three.
- When using `channels` filter on subscriptions, events emitted **without** a channel designation are excluded.
- The `filter` option works on tags attached during `emit()`. It does not filter on channels (use `channels` for that).
- `filter: { tags: ['a', 'b'], all: true }` requires **both** tags present. Default is any-match (at least one tag).
- The `tags` argument in `'log'` and `'request'` listeners is a pre-built boolean hash `{ tagName: true }` for O(1) lookup. Use `tags.error` instead of `event.tags.includes('error')`.
- `data` as a function (lazy evaluation) in `server.log()` and `server.events.emit()` is only invoked if matching listeners exist. Use this for expensive data generation.
- `clone: true` on event registration or subscription creates a deep clone of data for each listener. This prevents mutation side effects but has a performance cost.
- The `spread` option requires the emitted data to be an array. Non-array data with `spread: true` will cause unexpected behavior.
- `server.events.once()` without a listener returns a Promise. With a listener, it returns `this` (for chaining). Don't confuse the two forms.

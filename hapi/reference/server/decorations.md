## Server Decorations


`server.decorate()` extends framework interfaces with custom methods or properties. Decorations are globally available once registered and persist across plugins.


### Signature


```typescript
server.decorate(type, property, method, [options])
```

| Parameter  | Type                                                            | Description                                                         |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `type`     | `'handler' \| 'request' \| 'response' \| 'server' \| 'toolkit'` | The interface to decorate.                                          |
| `property` | `string \| symbol`                                              | The decoration key name. Must not collide with reserved properties. |
| `method`   | `function \| any`                                               | The extension function or value to assign.                          |
| `options`  | `{ apply?, extend? }`                                           | Optional behavior modifiers (see below).                            |


### Options


| Option   | Type      | Applies To                     | Description                                                                                                                                                                                  |
| -------- | --------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply`  | `boolean` | `request` only                 | If `true`, `method` is called with `function(request)` on each request and the return value becomes the decoration. Useful for per-request computed values.                                  |
| `extend` | `boolean` | `request`, `toolkit`, `server` | If `true`, overrides an existing decoration. The `method` receives the previous value via `function(existing)` and must return the new value. **Cannot be used with `handler` decorations.** |


### Decoration Type: `toolkit`


Adds methods to the response toolkit (`h`). The function's `this` is bound to the toolkit.

```typescript
const success = function (this: ResponseToolkit) {

    return this.response({ status: 'ok' });
};

server.decorate('toolkit', 'success', success);

server.route({
    method: 'GET',
    path: '/',
    handler: (request, h) => {

        return h.success();    // { status: 'ok' }
    }
});
```


### Decoration Type: `server`


Adds methods or properties to the Server object. Available on all server references including inside plugins.

```typescript
server.decorate('server', 'getTime', () => {

    return new Date().toISOString();
});

console.log(server.getTime());
```

For methods that need the server context, use a regular function:

```typescript
server.decorate('server', 'getPluginCount', function (this: Server) {

    return Object.keys(this.registrations).length;
});
```


### Decoration Type: `request`


Adds methods or properties to the Request object.

**Static decoration** (same value on every request):

```typescript
server.decorate('request', 'getIp', function (this: Request) {

    return this.info.remoteAddress;
});

// In handler:
const ip = request.getIp();
```

**Per-request decoration with `apply: true`** — the function is invoked on each request and the return value is assigned as the decoration:

```typescript
server.decorate('request', 'startedAt', (request) => {

    return Date.now();
}, { apply: true });

// In handler:
console.log(request.startedAt);    // number (timestamp per request)
```

With `apply: true`, the decoration is a computed value (not a method the handler calls). The function receives the current `request` and its return value is set directly on `request.startedAt`.


### Decoration Type: `handler`


Adds a new handler type for routes. The `method` must be a factory function with signature `function(route, options)` that returns a lifecycle handler.

```typescript
const handler = function (route: RequestRoute, options: { msg: string }) {

    return function (request: Request, h: ResponseToolkit) {

        return 'new handler: ' + options.msg;
    };
};

server.decorate('handler', 'test', handler);

server.route({
    method: 'GET',
    path: '/',
    handler: { test: { msg: 'hello' } }
});
```

**Handler defaults** — set default route config for routes using this handler by assigning a `defaults` property on the factory function:

```typescript
const handler = function (route: RequestRoute, options: any) {

    return function (request: Request, h: ResponseToolkit) {

        return request.payload;
    };
};

handler.defaults = {
    payload: {
        output: 'stream',
        parse: false
    }
};

server.decorate('handler', 'streamHandler', handler);
```

The `defaults` property can also be a function with signature `function(method)` that returns a route config object.


### Decoration Type: `response`


Adds methods to the Response object. Works similarly to `request` decorations.

```typescript
server.decorate('response', 'timestamp', function (this: ResponseObject) {

    this.header('x-timestamp', Date.now().toString());
    return this;
});

// In handler:
return h.response({ ok: true }).timestamp();
```


### Extending Existing Decorations


Use `{ extend: true }` to override a decoration set by another plugin. The `method` receives the previous value and must return the replacement:

```typescript
// Plugin A registers:
server.decorate('server', 'util', () => 'original');

// Plugin B extends:
server.decorate('server', 'util', (existing) => {

    return () => existing() + ' + extended';
}, { extend: true });

server.util();    // 'original + extended'
```

`extend` cannot be used with `handler` decorations.


### Reserved Property Names


Certain property names are reserved and cannot be used as decoration keys. Attempting to use them throws an error.

**Reserved `request` keys:**

`server`, `url`, `query`, `path`, `method`, `mime`, `setUrl`, `setMethod`, `headers`, `id`, `app`, `plugins`, `route`, `auth`, `pre`, `preResponses`, `info`, `isInjected`, `orig`, `params`, `paramsArray`, `payload`, `state`, `response`, `raw`, `domain`, `log`, `logs`, `generateResponse`

**Reserved `toolkit` keys:**

`abandon`, `authenticated`, `close`, `context`, `continue`, `entity`, `redirect`, `realm`, `request`, `response`, `state`, `unauthenticated`, `unstate`

**Reserved `server` keys:**

`app`, `auth`, `cache`, `decorations`, `events`, `info`, `listener`, `load`, `methods`, `mime`, `plugins`, `registrations`, `settings`, `states`, `type`, `version`, `realm`, `control`, `decoder`, `bind`, `decorate`, `dependency`, `encoder`, `event`, `expose`, `ext`, `inject`, `log`, `lookup`, `match`, `method`, `path`, `register`, `route`, `rules`, `state`, `table`, `validator`, `start`, `initialize`, `stop`


### server.decorations Property


Read-only object listing all applied decorations. Do not modify directly.

```typescript
server.decorate('toolkit', 'success', () => 'ok');
console.log(server.decorations.toolkit);     // ['success']
```

| Property                      | Type       | Description                               |
| ----------------------------- | ---------- | ----------------------------------------- |
| `server.decorations.request`  | `string[]` | Decoration names on the Request object.   |
| `server.decorations.response` | `string[]` | Decoration names on the Response object.  |
| `server.decorations.toolkit`  | `string[]` | Decoration names on the response toolkit. |
| `server.decorations.server`   | `string[]` | Decoration names on the Server object.    |


### TypeScript: Module Augmentation


Decorations are not automatically reflected in types. You must augment the appropriate interface:

**Server decoration:**

```typescript
declare module '@hapi/hapi' {
    interface Server {
        getTime(): string;
    }
}

server.decorate('server', 'getTime', () => new Date().toISOString());
server.getTime();    // typed as string
```

**Request decoration:**

```typescript
declare module '@hapi/hapi' {
    interface Request {
        getIp(): string;
    }
}

server.decorate('request', 'getIp', function (this: Request) {
    return this.info.remoteAddress;
});
```

**Request decoration with `apply: true` (property, not method):**

```typescript
declare module '@hapi/hapi' {
    interface Request {
        startedAt: number;
    }
}

server.decorate('request', 'startedAt', (request: Request) => Date.now(), { apply: true });
```

**Toolkit decoration:**

```typescript
declare module '@hapi/hapi' {
    interface ResponseToolkit {
        success(): ResponseObject;
    }
}
```

**Handler decoration:**

```typescript
declare module '@hapi/hapi' {
    interface HandlerDecorations {
        test?: { msg: string };
    }
}
```


### Gotchas


- Decorations are **not** scoped to plugins — they apply globally. A decoration registered in one plugin is available everywhere.
- You cannot register the same decoration name twice unless using `{ extend: true }`. Duplicate registration throws.
- `apply: true` only works with `request` type. It makes the decoration a computed per-request property, not a callable method.
- Arrow functions cannot use `this` binding. Use `function` declarations when `this` context is needed (e.g. `this.response()` in toolkit decorations).
- Handler defaults set via `handler.defaults` are merged with the route config. They do not override explicit route settings.
- Symbols can be used as property names for private decorations not exposed by string key.

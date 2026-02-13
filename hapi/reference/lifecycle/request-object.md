## Request Object


The request object is created internally for each incoming request. It is **not** the same object from the Node HTTP server callback (that is available via `request.raw.req`). Properties change throughout the request lifecycle.


### Request Properties


| Property | Access | Description |
|---|---|---|
| `app` | read/write | Application-specific state. Safe from framework conflicts. Plugins should use `plugins[name]`. |
| `auth` | read only | Authentication information (see below). |
| `events` | read only | Request event emitter (see events section). |
| `headers` | read only | Raw request headers (references `request.raw.req.headers`). |
| `info` | read only | Request metadata (see below). |
| `isInjected` | read only | `true` if created via `server.inject()`, `false` otherwise. |
| `logs` | read only | Array of logged request events. Empty if `route.options.log.collect` is `false`. |
| `method` | read only | Request method in lower case (e.g. `'get'`, `'post'`). |
| `mime` | read only | Parsed content-type header. Only available when payload parsing is enabled and no payload error occurred. |
| `orig` | read only | Object with `params`, `query`, `payload`, `state` values before validation modifications. Only set when validation is performed. |
| `params` | read only | Object where each key is a path parameter name with its matched value. |
| `paramsArray` | read only | Array of path parameter values in the order they appeared in the path. |
| `path` | read only | The request URI's pathname component. |
| `payload` | read only (write in `onRequest`) | Request payload based on route `payload.output` and `payload.parse`. `undefined` in `onRequest`; set to non-`undefined` to bypass payload processing. |
| `plugins` | read/write | Plugin-specific state. Each key is a plugin name. |
| `pre` | read only | Object of pre-handler method results. Keys are the `assign` names, values are the raw return values. |
| `preResponses` | read only | Same as `pre` but values are the response objects created by the pre method. |
| `query` | read only | Parsed query parameters. Can be modified indirectly via `request.setUrl()`. |
| `raw` | read only | Node HTTP objects: `{ req: http.IncomingMessage, res: http.ServerResponse }`. Direct interaction not recommended. |
| `response` | read/write (limited) | The response object when set. Can be modified but must not be reassigned. Return a new value from extension points to replace it. Contains a Boom error when request terminates early (client disconnect). |
| `route` | read only | Route information object (see below). |
| `server` | read only | The server object (public interface). |
| `state` | read only | Parsed HTTP cookies. Each key is a cookie name, value is the processed content per registered cookie definitions. |
| `url` | read only | Parsed request URI (`URL` object). Can be `null` in `onRequest` if the incoming path is invalid. |


### `request.auth`


| Property | Type | Description |
|---|---|---|
| `artifacts` | object | Artifact object received from the authentication strategy. |
| `credentials` | `AuthCredentials` | Credential object from authentication. Presence does not mean success. Has optional `scope`, `user`, and `app` fields. |
| `error` | `Error` | Authentication error when mode is `'try'`. |
| `isAuthenticated` | boolean | `true` if successfully authenticated. |
| `isAuthorized` | boolean | `true` if successfully authorized against route `access` config. |
| `isInjected` | boolean \| undefined | `true` if authenticated via `server.inject()` `auth` option. |
| `mode` | `'required' \| 'optional' \| 'try'` | Route authentication mode. |
| `strategy` | string | Name of the strategy used. |


### `request.info`


| Property | Type | Description |
|---|---|---|
| `acceptEncoding` | string | Request preferred encoding. |
| `cors` | object | CORS info. `cors.isOriginMatch`: `true` if Origin header matches configured restrictions. Only available after `onRequest` (CORS is per-route). |
| `host` | string | HTTP Host header (e.g. `'example.com:8080'`). |
| `hostname` | string | Hostname from Host header (e.g. `'example.com'`). |
| `id` | string | Unique request ID. Format: `'{now}:{server.info.id}:{5 digits counter}'`. |
| `received` | number | Request reception timestamp. |
| `referrer` | string | HTTP Referrer/Referer header content. |
| `remoteAddress` | string | Remote client IP address. |
| `remotePort` | string | Remote client port. |
| `responded` | number | Response timestamp. `0` if not responded yet or response failed when `completed` is set. |
| `completed` | number | Processing completion timestamp. `0` if still processing. |

The `request.info` object is not meant to be modified.


### `request.route`


| Property | Type | Description |
|---|---|---|
| `method` | string | Route HTTP method (lowercase, or `'*'`). |
| `path` | string | Route path. |
| `vhost` | string \| string[] | Route vhost option if configured. |
| `realm` | `ServerRealm` | Active realm associated with the route. |
| `settings` | `RouteSettings` | Route options with all defaults applied. |
| `fingerprint` | string | Internal normalized path string. |
| `auth.access(request)` | function | Validates a request against route auth access config (see below). |


#### `request.route.auth.access(request)`


Validates a request against the route's authentication access configuration.

- Returns `true` if the request would pass the route's access requirements.
- Ignores the route's auth mode and strategies.
- Matches only `request.auth.credentials` scope/entity against the route `access` config.
- Dynamic scopes are constructed against `request.query`, `request.params`, `request.payload`, and `request.auth.credentials`.
- Returns `false` for unauthenticated requests if the route requires any authentication.


### Request Methods


#### `request.active()`


Returns `true` when the request is active and processing should continue. Returns `false` when the request terminated early or completed its lifecycle. Use this to short-circuit expensive operations.

```js
const handler = function (request, h) {

    // Do some work...

    if (!request.active()) {
        return h.close;
    }

    // Do more work...

    return result;
};
```


#### `request.generateResponse(source, [options])`


Returns a response object. Used for creating custom response types (e.g. by plugins like Vision or Inert).

- `source` -- the value to set as the response source.
- `options`:
    - `variety` -- string name of the response type (e.g. `'file'`).
    - `prepare` -- `async function(response)` called after the response is returned by a lifecycle method. Must return the prepared response. May throw an error.
    - `marshal` -- `async function(response)` called before transmission. Must return the prepared value (not a response object). May throw.
    - `close` -- `function(response)` called to close resources (e.g. file handles). Should not throw (errors are logged but ignored).


#### `request.log(tags, [data])`


Logs request-specific events. The server emits a `'request'` event on the `'app'` channel.

- `tags` -- string or array of strings (e.g. `['error', 'database', 'read']`).
- `data` -- (optional) message string, object, or function (`function()` returning the data).

```js
const handler = function (request, h) {

    request.log(['test', 'error'], 'Test event');
    return 'ok';
};

// Listen for request logs
server.events.on({ name: 'request', channels: 'app' }, (request, event, tags) => {

    if (tags.error) {
        console.log(event);
    }
});
```

Internal server logs use the `'internal'` channel:

```js
server.events.on({ name: 'request', channels: 'internal' }, (request, event, tags) => {

    console.log(event);
});
```

Note: `request.logs` will be empty unless `route.options.log.collect` is `true`.


#### `request.setMethod(method)`


Changes the request method before routing. Can **only** be called from an `onRequest` extension.

- `method` -- HTTP method string (e.g. `'GET'`).

```js
server.ext('onRequest', (request, h) => {

    request.setMethod('GET');
    return h.continue;
});
```


#### `request.setUrl(url, [stripTrailingSlash])`


Changes the request URI before routing. Can **only** be called from an `onRequest` extension.

- `url` -- new request URI. Can be a string or a `URL` instance (uses `url.href`).
- `stripTrailingSlash` -- if `true`, strip the trailing slash from the path. Default: `false`.

```js
server.ext('onRequest', (request, h) => {

    // URL rewrite
    request.setUrl('/test');
    return h.continue;
});
```


### Request Events


Access via `request.events` (Podium interface).

| Event | Signature | When |
|---|---|---|
| `'peek'` | `function(chunk, encoding)` | Each chunk of payload data read from the client. |
| `'finish'` | `function()` | Request payload finished reading. |
| `'disconnect'` | `function()` | Request errors or aborts unexpectedly. |

```js
server.ext('onRequest', (request, h) => {

    const hash = Crypto.createHash('sha1');
    request.events.on('peek', (chunk) => {

        hash.update(chunk);
    });

    request.events.once('finish', () => {

        console.log(hash.digest('hex'));
    });

    request.events.once('disconnect', () => {

        console.error('request aborted');
    });

    return h.continue;
});
```


### TypeScript Interface


```ts
interface Request<Refs extends ReqRef = ReqRefDefaults> extends Podium {
    app: MergeRefs<Refs>['RequestApp'];
    readonly auth: RequestAuth;
    events: RequestEvents;
    readonly headers: MergeRefs<Refs>['Headers'];
    readonly info: RequestInfo;
    readonly isInjected: boolean;
    readonly logs: RequestLog[];
    readonly method: Lowercase<HTTP_METHODS>;
    readonly mime: string;
    readonly orig: RequestOrig;
    readonly params: MergeRefs<Refs>['Params'];
    readonly paramsArray: string[];
    readonly path: string;
    readonly payload: MergeRefs<Refs>['Payload'];
    plugins: PluginsStates;
    readonly pre: MergeRefs<Refs>['Pres'];
    readonly preResponses: Record<string, unknown>;
    readonly query: MergeRefs<Refs>['Query'];
    readonly raw: { req: http.IncomingMessage; res: http.ServerResponse };
    response: ResponseObject | Boom;
    readonly route: RequestRoute<Refs>;
    readonly server: MergeRefs<Refs>['Server'];
    readonly state: Record<string, unknown>;
    readonly url: url.URL;

    active(): boolean;
    generateResponse(source: string | object | null, options?: {
        variety?: string;
        prepare?: (response: ResponseObject) => Promise<ResponseObject>;
        marshal?: (response: ResponseObject) => Promise<ResponseValue>;
        close?: (response: ResponseObject) => void;
    }): ResponseObject;
    log(tags: string | string[], data?: string | object | (() => string | object)): void;
    setMethod(method: HTTP_METHODS | Lowercase<HTTP_METHODS>): void;
    setUrl(url: string | url.URL, stripTrailingSlash?: boolean): void;
}
```

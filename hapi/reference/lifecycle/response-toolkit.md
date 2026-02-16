## Response Toolkit (`h`)


The response toolkit is passed as the second argument to every lifecycle method. By convention it is named `h`.


### Toolkit Signals (Symbols)


#### `h.continue`


Returns from a lifecycle method without changing the response. Standard return value for extensions that perform side effects only.

```js
server.ext('onPreAuth', (request, h) => {

    // do something
    return h.continue;
});
```

Cannot be used by the `authenticate()` scheme method.


#### `h.abandon`


Skips to request finalization without interacting with the node response stream. The developer must write and end the response directly via `request.raw.res`.

```js
const handler = function (request, h) {

    request.raw.res.writeHead(200, { 'Content-Type': 'text/plain' });
    request.raw.res.end('custom response');
    return h.abandon;
};
```


#### `h.close`


Skips to request finalization after calling `request.raw.res.end()` to close the node response stream.

```js
const handler = function (request, h) {

    request.raw.res.write('partial');
    return h.close;
};
```


### Toolkit Properties


#### `h.context`


Access: read / write.

The route or server context set via the route `bind` option or `server.bind()`. Modifying the object will impact the shared context for all requests using the same route.


#### `h.realm`


Access: read only.

The server realm associated with the matching route. Defaults to the root server realm during the `onRequest` step.


#### `h.request`


Access: read only (public request interface).

The current request object. This is a duplication of the `request` argument passed to the lifecycle method. Primarily useful for toolkit decorations that need to access the current request.


### Toolkit Methods


#### `h.response([value])` -- Wrap a value in a response object


Wraps the provided value and returns a response object for customization (status code, headers, etc.).

- `value` -- (optional) return value. Defaults to `null`.

Returns: `ResponseObject`.

```js
// Detailed notation
const handler = function (request, h) {

    const response = h.response('success');
    response.type('text/plain');
    response.header('X-Custom', 'some-value');
    return response;
};

// Chained notation
const handler = function (request, h) {

    return h.response('success')
        .type('text/plain')
        .header('X-Custom', 'some-value');
};
```


#### `h.redirect(uri)` -- Redirect response


Redirects the client to the specified URI. Equivalent to `h.response().redirect(uri)`. Default status code is 302.

Returns: `ResponseObject` (with redirect methods `temporary()`, `permanent()`, `rewritable()`).

```js
const handler = function (request, h) {

    return h.redirect('http://example.com');
};
```


#### `h.entity(options)` -- Conditional response (ETag / Last-Modified)


Sets `ETag` and `Last-Modified` headers and checks conditional request headers for a potential 304 Not Modified response.

- `options` -- required configuration object:
    - `etag` -- the ETag string. Required if `modified` is not present.
    - `modified` -- the `Last-Modified` header value. Required if `etag` is not present.
    - `vary` -- same as `response.etag()` vary option. Defaults to `true`.

Returns:
- A `ResponseObject` if the response is unmodified (return this as the lifecycle value to send 304).
- `undefined` if the response has changed (you must then return a valid lifecycle value).

```js
const handler = function (request, h) {

    const response = h.entity({ etag: 'abc' });
    if (response) {
        response.header('X', 'y');   // can customize the 304 response
        return response;
    }

    return 'ok';                     // entity changed, return fresh data
};
```


#### `h.authenticated(data)` -- Auth scheme success


Used by authentication scheme methods to indicate successful authentication.

- `data` -- an object with:
    - `credentials` -- (required) object representing the authenticated entity.
    - `artifacts` -- (optional) authentication artifacts specific to the scheme.

Returns: an internal authentication object.

```js
const scheme = function (server, options) {

    return {
        authenticate: function (request, h) {

            const token = request.headers.authorization;
            const user = validate(token);
            return h.authenticated({ credentials: { user } });
        }
    };
};
```

TypeScript:

```ts
h.authenticated(data: AuthenticationData): Auth
```


#### `h.unauthenticated(error, [data])` -- Auth scheme failure


Used by authentication scheme methods to indicate failed authentication, optionally passing back credentials.

- `error` -- (required) the authentication error.
- `data` -- (optional) object with:
    - `credentials` -- (required) object representing the authenticated entity.
    - `artifacts` -- (optional) authentication artifacts.

Useful with `'try'` auth mode to pass expired credentials for error customization.

If no credentials are passed, there is no difference between throwing the error and calling `h.unauthenticated()`, but calling the method can improve code clarity.

```js
authenticate: function (request, h) {

    const token = request.headers.authorization;
    if (!token) {
        return h.unauthenticated(Boom.unauthorized('Missing token'));
    }

    const user = validate(token);
    if (user.expired) {
        return h.unauthenticated(
            Boom.unauthorized('Expired'),
            { credentials: { user } }
        );
    }

    return h.authenticated({ credentials: { user } });
}
```


#### `h.file(path, [options])` -- Serve a static file (requires @hapi/inert)


Added by the [@hapi/inert](../file-serving/overview.md) plugin. Transmits a file from the file system. Returns a standard response object.

```js
const handler = function (request, h) {

    return h.file('document.pdf', { mode: 'attachment' });
};
```

See [inert overview](../file-serving/overview.md) for full options and usage.


#### `h.state(name, value, [options])` -- Set a cookie


Sets a response cookie using the same arguments as `response.state()`.

Returns: none.

```js
const ext = function (request, h) {

    h.state('session', { sid: '12345' });
    return h.continue;
};
```


#### `h.unstate(name, [options])` -- Clear a cookie


Clears a response cookie using the same arguments as `response.unstate()`.

Returns: none.

```js
const ext = function (request, h) {

    h.unstate('session');
    return h.continue;
};
```


#### `h.view(template, [context, [options]])` -- Template response (via @hapi/vision)


Added by the [@hapi/vision](../views/overview.md) plugin. Returns a response object with variety `'view'`. The template is rendered during the [marshal pipeline](response-marshal.md).

    const handler = function (request, h) {

        return h.view('profile', { user: request.auth.credentials });
    };

See [vision overview](../views/overview.md) for full details, [engines](../views/engines.md) for engine configuration, and [context](../views/context.md) for context resolution and layouts.


### TypeScript Interface


```ts
interface ResponseToolkit<Refs extends ReqRef = ReqRefDefaults> {
    readonly abandon: symbol;
    readonly close: symbol;
    readonly context: any;
    readonly continue: symbol;
    readonly realm: ServerRealm;
    readonly request: Readonly<Request<Refs>>;

    authenticated(data: AuthenticationData): Auth;
    entity(options?: { etag?: string; modified?: string; vary?: boolean }): ResponseObject;
    redirect(uri?: string): ResponseObject;
    response(value?: ResponseValue): ResponseObject;
    state(name: string, value: string | object, options?: ServerStateCookieOptions): void;
    unauthenticated(error: Error, data?: AuthenticationData): Auth;
    unstate(name: string, options?: ServerStateCookieOptions): void;
}
```

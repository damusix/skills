## Response Object


The response object wraps a return value with HTTP headers, status code, and flags. When a lifecycle method returns a plain value, hapi wraps it automatically. Use `h.response()` to create one explicitly for customization.


### Creating a Response Object


```js
// Implicit -- hapi wraps automatically
const handler = function (request, h) {

    return 'hello';   // wrapped as response with 200 status
};

// Explicit -- use h.response() for customization
const handler = function (request, h) {

    return h.response('hello')
        .code(201)
        .type('text/plain')
        .header('X-Custom', 'value');
};
```


### Response Properties


| Property | Access | Default | Description |
|---|---|---|---|
| `app` | read/write | `{}` | Application-specific state. Safe from framework conflicts. Plugins should use `plugins[name]` instead. |
| `contentType` | read | none | Preview of the HTTP Content-Type header based on implicit type, explicit header, and charset. Can change later. `null` if no implicit type can be determined. |
| `events` | read only | Podium | Supports `'peek'` and `'finish'` events (see below). |
| `headers` | read only | `{}` | Response headers object. Incomplete until response is prepared for transmission. |
| `plugins` | read/write | `{}` | Plugin-specific state. Each key is a plugin name. |
| `settings` | read only | (see below) | Response handling flags. |
| `source` | read only | -- | The raw value returned by the lifecycle method. |
| `statusCode` | read only | `200` | The HTTP response status code. |
| `variety` | read only | -- | `'plain'` (string, number, null, object), `'buffer'`, or `'stream'`. |


#### `response.settings`


| Property | Default | Description |
|---|---|---|
| `passThrough` | `true` | If `true` and source is a Stream, copies the stream's `statusCode` and `headers` to the outbound response. |
| `stringify` | `null` | Override the route `json` options for stringification. |
| `ttl` | `null` | Override route cache expiration (milliseconds). |
| `varyEtag` | `false` | If `true`, appends encoding suffix to ETag when Vary header is present. |


#### `response.events`


| Event | Signature | When |
|---|---|---|
| `'peek'` | `function(chunk, encoding)` | Each chunk written back to the client. |
| `'finish'` | `function()` | Response finished writing, before connection is ended. |

```js
server.ext('onPreResponse', (request, h) => {

    const response = request.response;
    if (response.isBoom) {
        return h.continue;
    }

    const hash = Crypto.createHash('sha1');
    response.events.on('peek', (chunk) => {

        hash.update(chunk);
    });

    response.events.once('finish', () => {

        console.log(hash.digest('hex'));
    });

    return h.continue;
});
```


### Response Methods


All methods return the current response object (chainable) unless noted.


#### `response.bytes(length)`


Sets the HTTP `Content-Length` header to avoid chunked transfer encoding.

- `length` -- must match the actual payload size.


#### `response.charset([charset])`


Controls the `Content-Type` header's `charset` property.

- Without argument: prevents hapi from applying its default `utf-8` normalization.
- With `charset`: sets the charset value.


#### `response.code(statusCode)`


Sets the HTTP status code (e.g. `200`, `404`).


#### `response.message(httpMessage)`


Sets the HTTP status message (e.g. `'Ok'` for 200).


#### `response.compressed(encoding)`


Sets the HTTP `content-encoding` header.

- `encoding` -- the header value string (e.g. `'gzip'`).

**Note**: This does not set a `Vary: accept-encoding` header. Use `response.vary()` or `response.header()` for that.


#### `response.created(uri)`


Sets status code to `201` (Created) and sets the `Location` header.

- `uri` -- absolute or relative URI.


#### `response.encoding(encoding)`


Sets the string encoding scheme for serializing the payload.

- `encoding` -- Node Buffer encoding: `'ascii'`, `'utf8'`, `'utf16le'`, `'ucs2'`, `'base64'`, `'latin1'`, `'binary'`, `'hex'`.


#### `response.etag(tag, [options])`


Sets the representation entity tag (ETag).

- `tag` -- the entity tag string without double-quotes.
- `options`:
    - `weak` -- if `true`, prefix with `W/` weak signifier. Weak tags fail 304 matching. Default: `false`.
    - `vary` -- if `true` and content encoding is applied, encoding name is appended to the tag (separated by `-`). Ignored when `weak` is `true`. Default: `true`.


#### `response.header(name, value, [options])`


Sets an HTTP header.

- `name` -- header name.
- `value` -- header value.
- `options`:

| Option | Default | Description |
|---|---|---|
| `append` | `false` | Append to existing header value using `separator`. |
| `separator` | `','` | Separator used when appending. |
| `override` | `true` | If `false`, do not set if an existing value is present. |
| `duplicate` | `true` | If `false`, do not modify if value already included. Does not apply when `append` is `false` or name is `'set-cookie'`. |


#### `response.location(uri)`


Sets the HTTP `Location` header.

- `uri` -- absolute or relative URI.


#### `response.redirect(uri)`


Sets an HTTP redirection response (302 default) and decorates the response with `temporary()`, `permanent()`, and `rewritable()` methods.

- `uri` -- absolute or relative URI.


#### `response.replacer(method)`


Sets the `JSON.stringify()` replacer argument.

- `method` -- replacer function or array. Default: none.


#### `response.spaces(count)`


Sets the `JSON.stringify()` space argument.

- `count` -- number of spaces for indentation. Default: no indentation.


#### `response.state(name, value, [options])`


Sets an HTTP cookie.

- `name` -- cookie name.
- `value` -- cookie value. Must be a string if no `options.encoding` is defined.
- `options` -- (optional) merged with any server.state() defaults.


#### `response.suffix(suffix)`


Adds a string suffix to the response after JSON.stringify().


#### `response.ttl(msec)`


Overrides the route cache expiration for this response instance.

- `msec` -- time-to-live in milliseconds.


#### `response.type(mimeType)`


Sets the HTTP `Content-Type` header. Use only to override built-in defaults.

- `mimeType` -- the MIME type string.


#### `response.unstate(name, [options])`


Clears an HTTP cookie by setting an expired value.

- `name` -- cookie name.
- `options` -- (optional) merged with any server.state() definition.


#### `response.vary(header)`


Adds the header to the HTTP `Vary` header list.

- `header` -- the HTTP request header name.


#### `response.takeover()`


Marks the response as a takeover response. When returned from a lifecycle method, the lifecycle skips to Response validation (bypassing remaining steps).

```js
server.ext('onPreAuth', (request, h) => {

    if (request.path === '/cached') {
        return h.response('from cache')
            .code(200)
            .takeover();
    }

    return h.continue;
});
```


### Redirect Methods


These methods are only available after calling `response.redirect(uri)`.


#### `response.temporary([isTemporary])`


Sets status code to `302` or `307` (based on `rewritable()` setting).

- `isTemporary` -- if `false`, sets to permanent. Default: `true`.


#### `response.permanent([isPermanent])`


Sets status code to `301` or `308` (based on `rewritable()` setting).

- `isPermanent` -- if `false`, sets to temporary. Default: `true`.


#### `response.rewritable([isRewritable])`


Sets whether the redirect allows method rewriting (POST to GET).

- `isRewritable` -- if `false`, sets to non-rewritable. Default: `true`.

Redirect status code matrix:

|  | Permanent | Temporary |
|---|---|---|
| **Rewritable** | 301 | 302 |
| **Non-rewritable** | 308 | 307 |

```js
// 301 Permanent redirect (rewritable, allows POST -> GET)
return h.redirect('/new-path').permanent();

// 308 Permanent redirect (non-rewritable, preserves method)
return h.redirect('/new-path').permanent().rewritable(false);

// 307 Temporary redirect (non-rewritable, preserves method)
return h.redirect('/new-path').rewritable(false);
```


### TypeScript Interface


```ts
interface ResponseObject extends Podium {
    app: ResponseApplicationState;
    readonly contentType: string | null;
    readonly events: ResponseEvents;
    readonly headers: Record<string, string | string[]>;
    plugins: PluginsStates;
    readonly settings: ResponseSettings;
    readonly source: Lifecycle.ReturnValue;
    readonly statusCode: number;
    readonly variety: 'plain' | 'buffer' | 'stream';

    bytes(length: number): ResponseObject;
    charset(charset?: string): ResponseObject;
    code(statusCode: number): ResponseObject;
    message(httpMessage: string): ResponseObject;
    compressed(encoding: string): ResponseObject;
    created(uri: string): ResponseObject;
    encoding(encoding: BufferEncoding): ResponseObject;
    etag(tag: string, options?: { weak: boolean; vary: boolean }): ResponseObject;
    header(name: string, value: string, options?: ResponseObjectHeaderOptions): ResponseObject;
    location(uri: string): ResponseObject;
    redirect(uri: string): ResponseObject;
    replacer(method: Json.StringifyReplacer): ResponseObject;
    spaces(count: number): ResponseObject;
    state(name: string, value: object | string, options?: ServerStateCookieOptions): ResponseObject;
    suffix(suffix: string): ResponseObject;
    ttl(msec: number): ResponseObject;
    type(mimeType: string): ResponseObject;
    unstate(name: string, options?: ServerStateCookieOptions): ResponseObject;
    vary(header: string): ResponseObject;
    takeover(): ResponseObject;
    temporary(isTemporary?: boolean): ResponseObject;
    permanent(isPermanent?: boolean): ResponseObject;
    rewritable(isRewritable?: boolean): ResponseObject;
}
```

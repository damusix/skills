## Response Marshalling


Marshalling is the process that transforms a handler's return value into bytes on the wire. It is not a single function — it is a **9-step pipeline built per-route** at registration time.


### The Pipeline Overview

```
Handler return → Response.wrap() → _prepare() → Marshal Cycle (9 steps) → transmit()
```

1. **Wrap** — raw value becomes a `Response` object
2. **Prepare** — stream passthrough, processor hooks
3. **Marshal cycle** — headers, body serialization, cookies
4. **Transmit** — compression, range, stream piping


### Step 0: Response Wrapping

Every handler return passes through `Response.wrap()` (`lib/response.js:73-86`):

| Return type | Action |
|---|---|
| Already a `Response` | Returned as-is |
| `Symbol` (`h.continue`, etc.) | Returned as-is |
| `Error` | Wrapped via `Boom.boomify()` |
| Anything else | Wrapped in `new Response(source, request)` |


### Source Detection and Variety

`_setSource()` (`lib/response.js:88-115`) determines the response `variety` and default content type:

| Source type | `variety` | Default content-type |
|---|---|---|
| `null` / `undefined` | `'plain'` | none |
| `string` | `'plain'` | `text/html` |
| object / number / boolean | `'plain'` | `application/json` |
| `Buffer` | `'buffer'` | `application/octet-stream` |
| `Stream.Readable` | `'stream'` | `application/octet-stream` |
| custom (via `generateResponse`) | user-supplied | user-supplied |

**Stream validation** (`lib/streams.js`): objects with `.pipe()` that are NOT `Stream.Readable` instances throw `Boom.badImplementation`. Object-mode streams also throw.


### The `_prepare()` Phase

Called once after wrapping (`lib/response.js:497-515`). Transitions `_state` from `'init'` to `'prepare'`.

For **stream** responses with `passThrough: true` (the default), `_passThrough()` runs:

- Copies upstream HTTP `statusCode` if none set locally
- Passes through all headers from the stream, filtering hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, etc.)
- Local headers override pass-through headers for all **except** `set-cookie` (which is appended)


### The Marshal Cycle

Built per-route at registration time (`lib/route.js:314-341`). Steps are conditional on route config:

```js
_buildMarshalCycle() {
    this._marshalCycle = [Headers.type];              // 1. always

    if (this.settings.cors)
        this._marshalCycle.push(Cors.headers);        // 2. if CORS enabled

    if (this.settings.security)
        this._marshalCycle.push(Security.headers);    // 3. if security enabled

    this._marshalCycle.push(Headers.entity);          // 4. always

    if (this.method === 'get' || this.method === '*')
        this._marshalCycle.push(Headers.unmodified);  // 5. GET/* only

    this._marshalCycle.push(Headers.cache);           // 6. always
    this._marshalCycle.push(Headers.state);           // 7. always (cookies)
    this._marshalCycle.push(Headers.content);         // 8. always (body marshal)

    if (auth._enabled(this, 'response'))
        this._marshalCycle.push(Auth.response);       // 9. if auth response enabled
}
```

Executed sequentially in `lib/transmit.js:38-43`:

```js
for (const func of response.request._route._marshalCycle) {
    await func(response);
}
```


#### 1. Content-Type (`Headers.type` — `lib/headers.js:111-117`)

Sets `content-type` only if none exists yet. Uses `response.contentType` getter which auto-appends `; charset=utf-8` for `text/*`, `application/json`, and `application/javascript`.


#### 2. CORS Headers (`Cors.headers` — `lib/cors.js:158-182`)

- `vary: origin`
- `access-control-allow-origin` (if origin matches)
- `access-control-allow-credentials`
- `access-control-expose-headers`


#### 3. Security Headers (`Security.headers` — `lib/security.js:56-86`)

All set with `override: false` (won't overwrite headers set by the handler):

- `strict-transport-security` (HSTS)
- `x-frame-options`
- `x-xss-protection`
- `x-download-options: noopen`
- `x-content-type-options: nosniff`
- `referrer-policy`


#### 4. Entity Headers (`Headers.entity` — `lib/headers.js:120-139`)

Propagates `ETag` and `Last-Modified` from `h.entity()` calls into response headers if not already set.


#### 5. Unmodified Check (`Headers.unmodified` — `lib/headers.js:142-163`)

GET and `*` routes only. Checks for 304 Not Modified:

- **Strong ETag**: `If-None-Match` vs `etag` header — exact string match
- **Vary-aware**: if `varyEtag` is true, also matches weak and encoding-appended variants (e.g., `"abc-gzip"`)
- **Weak verifier**: `If-Modified-Since` vs `last-modified` — date comparison
- If matched: sets `statusCode = 304`


#### 6. Cache-Control (`Headers.cache` — `lib/headers.js:12-32`)

- If status matches route's cache `_statuses` set: `max-age=N, must-revalidate[, private]`
- Privacy becomes `private` if user is authenticated **or** `set-cookie` was set
- Falls back to `settings.otherwise` (default `'no-cache'`) when caching is enabled but not applicable
- No-op if `cache-control` already set by handler


#### 7. Cookies (`Headers.state` — `lib/headers.js:65-108`)

- Iterates `request._states` (cookies set via `h.state()` / `response.state()`)
- Runs `autoValue` functions for registered cookies not already present
- Serializes via `core.states.format()`
- Appends to existing `set-cookie` header array
- On error: logs `['state', 'response', 'error']` and clears broken state


#### 8. Body Marshal (`Headers.content` — `lib/headers.js:35-62`)

The core body serialization step:

1. Calls `response._marshal()` which transitions to `'marshall'` state
2. If `processors.marshal` exists (plugin hook), it runs first and may replace the source
3. For non-string plain values: JSON-serializes with route's `json` settings (`space`, `replacer`, `suffix`) and optional `Hoek.escapeJson()` for XSS safety
4. Wraps result in `Response.Payload` (a Readable with `.size()` and `.writeToStream()`)
5. Sets `content-length` from `_payload.size()` if available
6. For HEAD and 304: closes the payload stream and replaces with empty stream

```js
// lib/headers.js:35-62
if (response._isPayloadSupported() || request.method === 'head') {
    await response._marshal();
    if (typeof response._payload.size === 'function') {
        response._header('content-length', response._payload.size(), { override: false });
    }
    if (!response._isPayloadSupported()) {   // HEAD or 304
        response._close();
        response._payload = new internals.Empty();
    }
}
```

`_isPayloadSupported()` returns `false` for HEAD, 304, and 204 responses.


#### 9. Auth Response (`Auth.response`)

Runs last. Validates response headers against the auth strategy's `response()` method (e.g., Hawk authentication appends `Server-Authorization` headers).


### Transmission (`lib/transmit.js:82-120`)

After the marshal cycle, `internals.transmit()` handles final assembly:

```
                         ┌─────────┐
                         │ _payload │
                         └────┬────┘
                              │
                         ┌────▼────┐
                         │  peek?  │  (response.events listeners)
                         └────┬────┘
                              │
                        ┌─────▼──────┐
                        │ compressor? │  (gzip/deflate/custom)
                        └─────┬──────┘
                              │
                         ┌────▼────┐
                         │ ranger? │  (206 byte range)
                         └────┬────┘
                              │
                         ┌────▼────┐
                         │  res    │  (Node HTTP response)
                         └─────────┘
```


#### Length Handling (`transmit.js:123-153`)

- Parses string `content-length` to integer; removes invalid values
- **Auto-204**: if length is 0 and status is 200 (not explicitly set via `code()`) and `emptyStatusCode !== 200`: upgrades to 204 and removes `content-length`


#### Compression (`lib/compression.js`)

Decision flow:
1. If `response.compressed()` was called → use that encoding, skip auto-compression
2. If `server.options.compression === false` or payload < `minBytes` (default 1024) → skip
3. Check MIME compressibility via `@hapi/mimos`
4. Add `vary: accept-encoding`
5. Negotiate via `Accept-Encoding` header using `@hapi/accept`
6. Remove `content-length` (compressed size unknown)
7. Set `content-encoding` header
8. If `varyEtag`: append encoding suffix to ETag (e.g., `"abc"` → `"abc-gzip"`)

Built-in encoders: `gzip`, `deflate`. Custom encoders via `server.encoder()` are prepended (highest priority).

If the payload stream implements `setCompressor(compressor)`, hapi calls it — allowing mid-stream flush control.


#### Range Support (`transmit.js:156-203`)

For GET with `response.ranges: true` on 200 responses with known length:
- Always sets `accept-ranges: bytes`
- Validates `If-Range` against current ETag
- Parses `Range` header via `@hapi/ammo`
- Single range: sets 206, updates `content-length`, sets `content-range`, returns `Ammo.Clip` transform
- Multiple ranges: silently ignored (no multipart/byteranges)
- Invalid range: throws 416


#### Piping (`transmit.js:238-273`)

Two paths:
- **Synchronous payloads** (string/buffer): stream has `.writeToStream(res)` — called directly, avoids pipe overhead
- **Real streams**: `stream.pipe(request.raw.res)`

Termination events:
- `res.finish` → normal end, records `request.info.responded`
- `res.close` or `req.aborted` → disconnect, sets status 499 (configurable via `response.disconnectStatusCode`)
- `res.error` → destroys connection


### Error Response Flow

When the marshal cycle fails (`lib/transmit.js:46-69`):

1. The Boom error's `output.payload` becomes a new `Response` (variety `'plain'`, JSON-serialized)
2. `output.headers` are cloned and applied
3. Marshal cycle runs again on this error response
4. If that also fails: falls back to a **minimal JSON** representation (statusCode, error, message) — the last safety net


### Response State Machine

```
init → prepare → marshall → close
```

- `_prepare()` asserts state is `'init'`
- `_marshal()` asserts state is `'prepare'`
- Calling `_prepare()` twice throws
- `_close()` drains streams to prevent resource leaks
- When extensions replace a response, the old one is automatically closed (`lib/request.js:516-533`)


### Custom Variety (Plugin Extension Point)

Plugins like `@hapi/inert` use `request.generateResponse(source, options)`:

```js
const response = request.generateResponse(filePath, {
    variety: 'file',
    marshal(response) {
        // Open file stream, set headers
        return fileStream;
    },
    prepare(response) {
        // Stat file, set ETag/Last-Modified
    },
    close(response) {
        // Close file descriptor
    }
});
```

The custom `marshal` processor runs at the start of `_marshal()` and its return value replaces the source for the rest of the pipeline.


### Peek Events

`response.events` (lazily created Podium emitter) supports:

- `'peek'` — emitted for each chunk with `[chunk, encoding]`
- `'finish'` — emitted when response stream finishes

A `Response.Peek` Transform stream is inserted into the pipe chain (`lib/response.js:633-646`). It observes bytes without modifying them.

```js
server.ext('onPreResponse', (request, h) => {

    request.response.events.on('peek', (chunk, encoding) => {
        // Observe outgoing bytes
    });

    return h.continue;
});
```


### Injection Behavior (`server.inject()`)

During injection (`transmit.js:108-113`):
- For `variety === 'plain'`: the original `source` is stored as `result` — the **pre-serialization** value
- This is why `res.result` in tests gives you the raw object, not a JSON string
- On disconnect/error: `res[Config.symbol].error` causes the inject promise to reject

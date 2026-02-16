## @hapi/boom Error Utility Reference


Boom is an HTTP-friendly error utility -- **not a plugin**. It creates rich `Error` objects with HTTP status codes, headers, and structured payloads. Hapi natively recognizes Boom errors: when thrown or returned from handlers, lifecycle methods, or auth schemes, hapi automatically converts them into properly formatted HTTP responses.

    const Boom = require('@hapi/boom');

    // In a handler
    const handler = function (request, h) {

        const user = await getUser(request.params.id);
        if (!user) {
            throw Boom.notFound('User not found');
        }

        return user;
    };

Boom does **not** use `server.register()`. It is a standalone utility imported directly.


### Constructor


**`new Boom.Boom(message, [options])`** -- creates a new Boom error object. (`lib/index.js`)

    const error = new Boom.Boom('Something went wrong', { statusCode: 422 });

| Option | Type | Default | Description |
|---|---|---|---|
| `statusCode` | `number` | `500` | HTTP status code. Must be >= 400. |
| `data` | `any` | `null` | Additional error data. Accessible via `error.data` but not included in the response payload. |
| `decorate` | `object` | -- | Properties to copy directly onto the error object. |
| `ctor` | `function` | -- | Constructor reference for cleaning up the stack trace via `Error.captureStackTrace`. |
| `message` | `string` | -- | Error message. Overrides the first argument if both are provided. |
| `override` | `boolean` | `true` | When `true` (default), always apply the provided `statusCode`. When `false`, only apply if the error does not already have a boom status. |

**`Boom.boomify(err, [options])`** -- decorates an existing `Error` with boom properties. Returns the same error object, modified in place. (`lib/index.js`)

    const err = new Error('database timeout');
    Boom.boomify(err, { statusCode: 503, message: 'Service unavailable' });
    // err.isBoom === true
    // err.output.statusCode === 503

| Option | Type | Default | Description |
|---|---|---|---|
| `statusCode` | `number` | `500` | HTTP status code to assign. |
| `message` | `string` | -- | Overrides the error message. The original message is preserved in `error.data.origMessage` if `data` is not set. |
| `decorate` | `object` | -- | Properties to copy onto the error object. |
| `override` | `boolean` | `true` | When `true`, always apply the provided `statusCode`. When `false`, only apply if the error is not already a boom error. |

**`Boom.isBoom(err, [statusCode])`** -- returns `true` if `err` is a Boom object. If `statusCode` is provided, also checks that the error matches that status code.

    Boom.isBoom(Boom.notFound());           // true
    Boom.isBoom(Boom.notFound(), 404);      // true
    Boom.isBoom(Boom.notFound(), 400);      // false
    Boom.isBoom(new Error('plain'));         // false


### Error Object Structure


Every Boom error has this shape:

    {
        isBoom: true,
        isServer: true | false,      // true for 5xx
        message: 'Human-readable message',
        typeof: ErrorClass,          // the factory that created it (e.g. Boom.notFound)
        data: null,                  // custom data attached via options
        output: {
            statusCode: 404,         // HTTP status code
            headers: {},             // response headers (e.g. WWW-Authenticate)
            payload: {
                statusCode: 404,
                error: 'Not Found',  // HTTP error name derived from statusCode
                message: 'Human-readable message'
            }
        }
    }

| Property | Description |
|---|---|
| `isBoom` | Always `true`. Used by hapi to detect boom errors. |
| `isServer` | `true` for 5xx status codes, `false` for 4xx. |
| `message` | The error message. For 5xx errors, the message is hidden from the response payload (shows `'An internal server error occurred'`). |
| `typeof` | Reference to the factory function that created the error (e.g., `Boom.notFound`). Useful for `instanceof`-style checks without comparing status codes. |
| `data` | Arbitrary data. Not sent in the response. Useful for logging or `onPreResponse` extensions. |
| `output.statusCode` | The HTTP status code sent in the response. |
| `output.headers` | Headers merged into the response. Used by `Boom.unauthorized` to set `WWW-Authenticate`. |
| `output.payload` | The response body. By default: `{ statusCode, error, message }`. |

**`error.reformat(debug)`** -- rebuilds `output.payload` from the current `output.statusCode` and `message`. Call after modifying `statusCode` or `message` directly. When `debug` is `false`, 5xx messages are hidden.

    const error = Boom.badRequest('oops');
    error.output.statusCode = 422;
    error.reformat();
    // error.output.payload.error === 'Unprocessable Entity'


### HTTP Error Factories


All factories return a Boom error object. Signature: `Boom.<method>(message, [data])` unless noted otherwise.

**4xx Client Errors:**

| Factory | Status | Default Message |
|---|---|---|
| `Boom.badRequest(message, data)` | 400 | `'Bad Request'` |
| `Boom.unauthorized(message, scheme, attributes)` | 401 | `'Unauthorized'` |
| `Boom.paymentRequired(message, data)` | 402 | `'Payment Required'` |
| `Boom.forbidden(message, data)` | 403 | `'Forbidden'` |
| `Boom.notFound(message, data)` | 404 | `'Not Found'` |
| `Boom.methodNotAllowed(message, data, allow)` | 405 | `'Method Not Allowed'` |
| `Boom.notAcceptable(message, data)` | 406 | `'Not Acceptable'` |
| `Boom.proxyAuthRequired(message, data)` | 407 | `'Proxy Authentication Required'` |
| `Boom.clientTimeout(message, data)` | 408 | `'Request Time-out'` |
| `Boom.conflict(message, data)` | 409 | `'Conflict'` |
| `Boom.resourceGone(message, data)` | 410 | `'Gone'` |
| `Boom.lengthRequired(message, data)` | 411 | `'Length Required'` |
| `Boom.preconditionFailed(message, data)` | 412 | `'Precondition Failed'` |
| `Boom.entityTooLarge(message, data)` | 413 | `'Request Entity Too Large'` |
| `Boom.uriTooLong(message, data)` | 414 | `'Request-URI Too Long'` |
| `Boom.unsupportedMediaType(message, data)` | 415 | `'Unsupported Media Type'` |
| `Boom.rangeNotSatisfiable(message, data)` | 416 | `'Requested Range Not Satisfiable'` |
| `Boom.expectationFailed(message, data)` | 417 | `'Expectation Failed'` |
| `Boom.teapot(message, data)` | 418 | `'I\'m a Teapot'` |
| `Boom.badData(message, data)` | 422 | `'Unprocessable Entity'` |
| `Boom.locked(message, data)` | 423 | `'Locked'` |
| `Boom.failedDependency(message, data)` | 424 | `'Failed Dependency'` |
| `Boom.tooEarly(message, data)` | 425 | `'Too Early'` |
| `Boom.preconditionRequired(message, data)` | 428 | `'Precondition Required'` |
| `Boom.tooManyRequests(message, data)` | 429 | `'Too Many Requests'` |
| `Boom.illegal(message, data)` | 451 | `'Unavailable For Legal Reasons'` |

**5xx Server Errors:**

| Factory | Status | Default Message |
|---|---|---|
| `Boom.internal(message, data, statusCode)` | 500 | `'Internal Server Error'` |
| `Boom.notImplemented(message, data)` | 501 | `'Not Implemented'` |
| `Boom.badGateway(message, data)` | 502 | `'Bad Gateway'` |
| `Boom.serverUnavailable(message, data)` | 503 | `'Service Unavailable'` |
| `Boom.gatewayTimeout(message, data)` | 504 | `'Gateway Time-out'` |
| `Boom.badImplementation(message, data)` | 500 | `'Internal Server Error'` |

`Boom.badImplementation` is special: it sets `error.isDeveloperError = true`, which hapi logs differently. Use it for programmer errors (e.g., invalid configuration), not runtime failures.


### Boom.unauthorized -- Auth-Specific Usage


`Boom.unauthorized` has a unique signature for setting `WWW-Authenticate` headers, which hapi's auth system relies on:

    Boom.unauthorized(message, scheme, [attributes])

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `message` | `string \| null` | Error message. When `null`, the error is treated as "not applicable" rather than "failed" -- hapi's auth system uses this for strategy fallthrough. |
| `scheme` | `string` | Authentication scheme name (e.g., `'Bearer'`, `'Basic'`). Sets the `WWW-Authenticate` header. |
| `attributes` | `object \| string` | Key-value pairs appended to the `WWW-Authenticate` header. If a string, used as-is. |

**Examples:**

    // Simple -- no WWW-Authenticate header
    throw Boom.unauthorized('Bad credentials');
    // Response: 401, no WWW-Authenticate header

    // With scheme -- sets WWW-Authenticate: Bearer
    throw Boom.unauthorized('Bad token', 'Bearer');
    // Response: 401, WWW-Authenticate: Bearer

    // With scheme and attributes
    throw Boom.unauthorized('Expired', 'Bearer', { realm: 'api', error: 'invalid_token' });
    // Response: 401, WWW-Authenticate: Bearer realm="api", error="invalid_token"

    // String attributes
    throw Boom.unauthorized(null, 'Negotiate', 'VGhpcyBpcyBhIHRlc3Q=');
    // Response: 401, WWW-Authenticate: Negotiate VGhpcyBpcyBhIHRlc3Q=

**Auth fallthrough behavior in hapi:**

| Call | Hapi Behavior |
|---|---|
| `Boom.unauthorized('Invalid token')` | **Definitive failure** -- stops the auth chain, returns 401. |
| `Boom.unauthorized(null, 'SchemeName')` | **Not applicable** -- tries the next strategy (if `mode: 'try'` or multiple strategies configured). |

See [server auth](../server/auth.md) for full auth scheme integration.


### How Hapi Handles Boom Errors


When a lifecycle method throws or returns a Boom error, hapi processes it through the [response marshal pipeline](response-marshal.md):

1. Non-Boom `Error` objects are wrapped via `Boom.boomify(err)` (becomes 500).
2. The Boom error's `output.payload` is serialized as JSON and becomes the response body.
3. `output.statusCode` becomes the HTTP status code.
4. `output.headers` are merged into the response headers.
5. For 5xx errors, the original `message` is replaced with `'An internal server error occurred'` in the payload (to avoid leaking internal details). The real message is still available on the error object for logging.
6. The error passes through `onPreResponse` where it can be intercepted and replaced.

    // hapi automatically turns this:
    throw Boom.notFound('User 123 does not exist');

    // Into this HTTP response:
    // HTTP/1.1 404 Not Found
    // Content-Type: application/json
    //
    // {"statusCode":404,"error":"Not Found","message":"User 123 does not exist"}


### Customizing Error Responses


**Attach data for logging (not sent to client):**

    const error = Boom.badRequest('Validation failed');
    error.data = { field: 'email', value: request.payload.email };
    // error.data is available in onPreResponse but NOT in the HTTP response
    throw error;

**Modify the payload:**

    const error = Boom.badRequest('Invalid input');
    error.output.payload.validation = { source: 'payload', keys: ['email'] };
    throw error;
    // Response includes the extra "validation" field

**Change status code after creation:**

    const error = Boom.badRequest('Rate limited');
    error.output.statusCode = 429;
    error.reformat();  // Must call to update output.payload.error
    throw error;

**Add custom response headers:**

    const error = Boom.tooManyRequests('Slow down');
    error.output.headers['Retry-After'] = '60';
    throw error;

**Replace error responses globally via onPreResponse:**

    server.ext('onPreResponse', (request, h) => {

        const response = request.response;
        if (!response.isBoom) {
            return h.continue;
        }

        // Custom error shape
        return h.response({
            success: false,
            code: response.output.statusCode,
            message: response.message
        }).code(response.output.statusCode);
    });

**Use `data` for error context in onPreResponse:**

    // In handler
    throw Boom.forbidden('Insufficient permissions', { required: 'admin', actual: 'viewer' });

    // In onPreResponse
    server.ext('onPreResponse', (request, h) => {

        if (request.response.isBoom && request.response.data) {
            request.log(['error', 'context'], request.response.data);
        }

        return h.continue;
    });


### Gotchas


- **5xx messages are hidden.** Boom hides the message for 5xx errors in the response payload, replacing it with `'An internal server error occurred'`. The original message is preserved on the error object for server-side logging. Use `error.output.payload.message` to override what the client sees.
- **`reformat()` is required after manual changes.** If you change `output.statusCode` or `message` directly, call `error.reformat()` or the `output.payload.error` label will be stale.
- **`reformat()` resets custom payload properties.** Calling `reformat()` rebuilds the entire `output.payload` from scratch. Add custom payload properties **after** calling `reformat()`.
- **Boom is not a plugin.** Do not use `server.register()`. Import it directly: `const Boom = require('@hapi/boom')`.
- **`Boom.unauthorized(null, scheme)` vs `Boom.unauthorized(message)`.** The presence/absence of a message controls auth strategy fallthrough in hapi. `null` message = "try next strategy"; string message = "definitive failure." This is the most common auth mistake.
- **`Boom.badImplementation` sets `isDeveloperError`.** Hapi treats these differently in debug mode -- they include stack traces in the response when `debug.request` includes `'internal'`.
- **`boomify` mutates the original error.** It does not create a new Error object. The original error is modified in place and returned.
- **Throwing non-Error values.** Throwing a non-Error value (string, number, etc.) from a lifecycle method generates a `Boom.badImplementation` (500), not the thrown value.
- **`data` is never sent to the client.** The `data` property is only accessible server-side. Use `output.payload` to add fields to the client response.
- **Boom errors in `request.response`.** During lifecycle processing, `request.response` may contain a Boom error (check `request.response.isBoom`). This happens when the request terminates early, e.g., client disconnect. See [request object](request-object.md).
- **Selectively catching Boom errors.** Use [@hapi/bounce](bounce.md) to filter caught errors by type -- rethrow system errors while handling Boom errors, or vice versa. Bounce recognizes Boom errors via the `isBoom` property.

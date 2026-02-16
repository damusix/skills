## Lifecycle Methods


Lifecycle methods are the developer-provided functions that the framework calls at each step of the request lifecycle. They are used for extensions, authentication schemes, handlers, pre-handler methods, and `failAction` functions.


### Signature


```ts
async function (request: Request, h: ResponseToolkit, err?: Error): Lifecycle.ReturnValue
```

- `request` -- the [request object](#request-object).
- `h` -- the [response toolkit](#response-toolkit).
- `err` -- an error object, only available when the method is used as a `failAction` value.


### Return Values


Every lifecycle method **must** return a value or a promise that resolves to a value. Returning `undefined` (or resolving to `undefined`) results in a 500 Internal Server Error.

| Return type | Behavior |
|---|---|
| `null` | Plain response (JSON `null`) |
| `string` | Plain text/JSON response |
| `number` | Plain JSON response |
| `boolean` | Plain JSON response |
| `Buffer` | Binary response |
| `Error` / `Boom` | Error response. Plain `Error` is wrapped as Boom 500. |
| `Stream` | Streamed response. Must be streams2-compatible, not in `objectMode`. Stream `statusCode` and `headers` properties are copied based on `passThrough` option. |
| `object` / `array` | JSON response. Must not contain circular references. |
| `h.continue` (symbol) | Continue processing without changing the response. |
| `h.abandon` (symbol) | Skip to finalize; developer must write/end `request.raw.res` directly. |
| `h.close` (symbol) | Skip to finalize after calling `request.raw.res.end()`. |
| `h.response(value)` | Wrapped response object for customization. |
| `h.redirect(uri)` | Redirect response (302 by default). |
| `h.authenticated(data)` | Auth scheme only: indicates successful authentication. |
| `h.unauthenticated(error, data)` | Auth scheme only: indicates failed authentication. |
| Promise resolving to any above | Async lifecycle method. |

TypeScript type:

```ts
type Lifecycle.ReturnValue<Refs> =
    | null | string | number | boolean
    | Buffer
    | Error | Boom
    | Stream
    | object | object[]
    | symbol
    | Auth
    | Promise<any of the above>;
```


### Throwing vs Returning Errors


It is recommended to **throw** errors rather than return them:

```js
const handler = function (request, h) {

    if (request.query.forbidden) {
        throw Boom.badRequest();
    }

    return 'success';
};
```

Throwing a non-Error value generates a 500 Bad Implementation error response.


### Lifecycle Workflow


The flow after each lifecycle method depends on what it returns:

| Return value | Effect |
|---|---|
| Error | Skips to Response validation (from `onRequest`: skips to `onPreResponse`; from Response validation: skips to `onPreResponse`; from `onPreResponse`: skips to transmission). |
| `h.abandon` / `h.close` | Skips to Finalize request. |
| `h.continue` | Continues without changing the response. Cannot be used by `authenticate()`. |
| Takeover response | Overrides response and skips to Response validation. |
| Any other value | Overrides response and continues lifecycle. **Cannot be returned from any step before Pre-handler methods.** |


### `this` Binding


If the route has a `bind` option or `server.bind()` was called, the lifecycle method is bound to the provided context via `this`. The same context is accessible via `h.context`.

Arrow functions ignore `this` binding, so use regular `function` declarations when you need the bind context:

```js
// Works -- `this` is bound
server.route({
    method: 'GET',
    path: '/',
    options: {
        bind: { db: myDatabase },
        handler: function (request, h) {

            return this.db.query('SELECT 1');
        }
    }
});

// Does NOT work -- arrow function ignores `this`
handler: (request, h) => {
    return this.db.query('SELECT 1'); // `this` is lexical, not the bind context
};
```


### `failAction` Configuration


Various options (payload, cookies, validation) support a `failAction` that controls how errors are handled:

| Value | Behavior |
|---|---|
| `'error'` | Return the error object as the response (default). |
| `'log'` | Report the error but continue processing the request. |
| `'ignore'` | Take no action and continue processing the request. |
| `async function(request, h, err)` | A lifecycle method. Receives the error as the third argument. |

TypeScript type:

```ts
type Lifecycle.FailAction = 'error' | 'log' | 'ignore' | Lifecycle.Method;
```

Example custom `failAction`:

```js
server.route({
    method: 'POST',
    path: '/data',
    options: {
        validate: {
            payload: Joi.object({ name: Joi.string().required() }),
            failAction: async function (request, h, err) {

                // Log and return a custom error
                request.log(['validation', 'error'], err.message);
                throw Boom.badRequest('Invalid request payload');
            }
        },
        handler: function (request, h) {

            return 'ok';
        }
    }
});
```


### Pre-handler Methods vs Handler


Pre-handler methods (route `pre` option) and the route handler are both lifecycle methods, but they differ in how return values are handled:

- **Pre-handler**: The return value is stored in `request.pre[assign]` (raw value) and `request.preResponses[assign]` (response object). It does NOT become the request response.
- **Handler**: The return value becomes the request response.
- **Pre-handler with `failAction`**: Each pre-handler method can have its own `failAction` setting independent of the route's validation `failAction`.


### Error Transformation


Errors use the [Boom](boom.md) library. Key properties of a Boom error:

```js
{
    isBoom: true,
    message: 'error message',
    output: {
        statusCode: 400,           // HTTP status code
        headers: {},               // custom headers
        payload: {
            statusCode: 400,
            error: 'Bad Request',  // derived from statusCode
            message: 'error message'
        }
    }
}
```

Customizing error output:

```js
const error = Boom.badRequest('Cannot feed after midnight');
error.output.statusCode = 499;
error.reformat();
error.output.payload.custom = 'abc_123';
throw error;
```

Replacing errors with custom responses in `onPreResponse`:

```js
server.ext('onPreResponse', (request, h) => {

    const response = request.response;
    if (!response.isBoom) {
        return h.continue;
    }

    const statusCode = response.output.statusCode;
    return h.response({ error: true, statusCode })
        .code(statusCode);
});
```

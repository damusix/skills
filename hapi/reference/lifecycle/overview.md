## Request Lifecycle Overview


Every incoming request passes through a fixed sequence of steps. The specific steps that execute depend on server and route configuration, but their order never changes.


### Complete Lifecycle Flow


```
Request received
    |
    v
[1]  onRequest extensions
    |
    v
[2]  Route lookup (by path + method)
    |   \---> (no match) skip to onPreResponse
    v
[3]  Cookies processing (route state option)
    |
    v
[4]  onPreAuth extensions
    |
    v
[5]  Authentication (route auth option)
    |
    v
[6]  Payload processing (route payload option)
    |
    v
[7]  Payload authentication (route auth option)
    |
    v
[8]  onCredentials extensions (only if auth performed)
    |
    v
[9]  Authorization (route auth access option)
    |
    v
[10] onPostAuth extensions
    |
    v
[11] Headers validation (validate.headers)
    |
    v
[12] Path parameters validation (validate.params)
    |
    v
[13] Query validation (validate.query)
    |
    v
[14] Payload validation (validate.payload)
    |
    v
[15] State validation (validate.state)
    |
    v
[16] onPreHandler extensions
    |
    v
[17] Pre-handler methods (route pre option)
    |
    v
[18] Route handler
    |
    v
[19] onPostHandler extensions
    |
    v
[20] Response validation (validate.response)
    |
    v
[21] onPreResponse extensions (always called unless aborted)
    |
    v
[22] Response transmission
    |
    v
[23] Finalize request (emits 'response' event)
    |
    v
[24] onPostResponse extensions
```


### Extension Points Summary


| Extension | When | Notes |
|---|---|---|
| `onRequest` | Before routing | Can modify `request.path` and `request.method` via `setUrl()`/`setMethod()`. `request.route` is unassigned. `request.payload` is `undefined`. |
| `onPreAuth` | Before authentication | Called regardless of whether authentication is configured. |
| `onCredentials` | After authentication, before authorization | Only called when authentication is performed. |
| `onPostAuth` | After authorization | Called regardless of whether authentication is configured. |
| `onPreHandler` | After all validation, before handler | Last chance to intercept before the handler runs. |
| `onPostHandler` | After handler, before response validation | Can modify `request.response` (but not reassign it). Return a new value to replace it. |
| `onPreResponse` | After response validation, before transmission | Always called unless the request is aborted. Can replace error responses. Errors generated here do NOT re-enter `onPreResponse` (prevents infinite loops). |
| `onPostResponse` | After response transmission | Return value is ignored. All handlers run even if some error. Do not block -- defer IO to next tick. |


### How Errors Affect the Flow


When a lifecycle method returns or throws an error:

- **General rule**: the lifecycle skips to **Response validation**.
- **From `onRequest`**: skips to **onPreResponse**.
- **From Response validation**: skips to **onPreResponse**.
- **From `onPreResponse`**: skips to **Response transmission** (no re-entry to prevent loops).

All errors are converted to Boom objects. Non-Boom errors default to status code 500.


### Abort Signals


Returning `h.abandon` or `h.close` skips immediately to **Finalize request**.

- `h.abandon` -- skips finalization of the node response stream. The developer must write and end the response directly via `request.raw.res`.
- `h.close` -- calls `request.raw.res.end()` to close the stream, then finalizes.


### Takeover Responses


A takeover response is created by calling `response.takeover()` on a response object. When returned from a lifecycle method:

- Overrides the request response with the provided value.
- Skips to **Response validation** (bypassing remaining lifecycle steps).
- From Response validation: skips to **onPreResponse**.
- From `onPreResponse`: skips to **Response transmission**.

This is useful for short-circuiting the lifecycle, e.g. returning cached responses from extensions.


### `h.continue` Signal


Returning `h.continue` from a lifecycle method continues processing without changing the response. It is the standard return value for extension points that do not need to modify the response.

Cannot be used by the `authenticate()` scheme method.


### Key Gotchas


- Steps before **Pre-handler methods** cannot return a response value (other than errors, `h.continue`, or takeover). Only errors, `h.continue`, and takeover responses are allowed from extensions before the handler.
- `request.payload` is `undefined` during `onRequest`. You can override it with any non-`undefined` value to bypass payload processing entirely.
- `request.route` is unassigned during `onRequest`.
- `request.path` can be an invalid path during `onRequest` (per API.md).
- `request.url` can be `null` during `onRequest` if the incoming path is invalid.
- CORS information (`request.info.cors`) is not available during `onRequest` since CORS is configured per-route.
- `onPostResponse` handlers execute in serial (`await`ed). Avoid blocking -- defer IO to another tick and return immediately.

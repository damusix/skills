## hapi Server Extensions Reference


### server.ext(events) -- object form


Registers one or more extension functions for request lifecycle or server extension points.

```js
    server.ext({
        type: 'onRequest',
        method: function (request, h) {

            request.setUrl('/test');
            return h.continue;
        }
    });

    // Array of extensions
    server.ext([
        { type: 'onPreAuth', method: addTimestamp },
        { type: 'onPostHandler', method: addHeaders }
    ]);
```

**Extension object properties:**

| Property  | Required | Type                     | Description                             |
| --------- | -------- | ------------------------ | --------------------------------------- |
| `type`    | yes      | `string`                 | Extension point name                    |
| `method`  | yes      | `function \| function[]` | Handler function(s) to execute          |
| `options` | no       | `object`                 | Ordering, binding, and sandbox settings |


### server.ext(event, [method, [options]]) -- arguments form


Registers a single extension using positional arguments. Same properties as the object form.

```js
    server.ext('onRequest', function (request, h) {

        request.setUrl('/test');
        return h.continue;
    });
```

**Promise form (for testing):** If `method` is omitted or `null`, returns a promise that resolves with the `request` object on the first invocation of that extension point.

```js
    // Useful in tests -- await the next request hitting onPreHandler
    const requestPromise = server.ext('onPreHandler');
    const res = await server.inject('/test');
    const request = await requestPromise;
```


### Extension Options


| Option    | Type                   | Default        | Description                                                                                                                                                   |
| --------- | ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before`  | `string \| string[]`   | none           | Plugin name(s) this extension must execute before (same event)                                                                                                |
| `after`   | `string \| string[]`   | none           | Plugin name(s) this extension must execute after (same event)                                                                                                 |
| `bind`    | `object`               | active context | Context object passed as `this` to the method. Ignored for arrow functions.                                                                                   |
| `sandbox` | `'server' \| 'plugin'` | `'server'`     | `'plugin'` limits the extension to routes defined by the current plugin. Only for request extension points. Not allowed for route-level or server extensions. |
| `timeout` | `number`               | none           | Milliseconds to wait before returning a timeout error                                                                                                         |


### Request Extension Points (in lifecycle order)


These fire for every matching incoming request. Signature: `async function(request, h)` -- standard lifecycle methods.

| #   | Extension Point    | When it Fires                                                 | Key Behaviors                                                                                                                                                                                                                                                     |
| --- | ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **onRequest**      | Always (when extensions exist)                                | Can modify `request.path` and `request.method` via `request.setUrl()` / `request.setMethod()`. `request.route` is unassigned. `request.payload` is `undefined` and can be overridden to bypass payload processing. `request.url` can be `null` for invalid paths. |
| 2   | **onPreAuth**      | After route lookup and cookies, before auth                   | Called regardless of whether authentication is configured.                                                                                                                                                                                                        |
| 3   | **onCredentials**  | After authentication and payload auth succeed                 | Called **only** if authentication is performed. Fires after payload authentication.                                                                                                                                                                               |
| 4   | **onPostAuth**     | After authorization                                           | Called regardless of whether authentication is configured. Fires after access validation.                                                                                                                                                                         |
| 5   | **onPreHandler**   | After all validation (headers, params, query, payload, state) | Last chance to modify request before the handler runs.                                                                                                                                                                                                            |
| 6   | **onPostHandler**  | After handler, before response validation                     | `request.response` may be modified but not reassigned. Return a new value to replace the response entirely (e.g., replace error with HTML).                                                                                                                       |
| 7   | **onPreResponse**  | Always (unless request aborted)                               | Last chance to modify the response. Same modification rules as onPostHandler. Errors generated here do **not** re-trigger onPreResponse (prevents infinite loops).                                                                                                |
| 8   | **onPostResponse** | After response transmission and `'response'` event            | Return value is ignored. All handlers execute even if some error. Avoid blocking IO -- defer to next tick if doing IO.                                                                                                                                            |


### Server Extension Points


These fire during server lifecycle, not per-request. Signature: `async function(server)`.

| Extension       | When it Fires                                                      |
| --------------- | ------------------------------------------------------------------ |
| **onPreStart**  | Before connection listeners start. Caches are being initialized.   |
| **onPostStart** | After connection listeners start. Server is accepting requests.    |
| **onPreStop**   | Before connection listeners stop. Server still accepting requests. |
| **onPostStop**  | After connection listeners stop. Server is fully stopped.          |

```js
    server.ext('onPreStart', async (server) => {

        // Run database migrations, warm caches, etc.
        await runMigrations();
    });

    server.ext('onPostStart', async (server) => {

        console.log('Server running at:', server.info.uri);
    });

    server.ext('onPreStop', async (server) => {

        // Graceful shutdown preparation
        await drainQueues();
    });

    server.ext('onPostStop', async (server) => {

        // Close database connections, flush logs
        await db.close();
    });
```


### Complete Lifecycle Flow


```
    Request In
      |
      v
    onRequest  -->  Route Lookup  -->  Cookies  -->  onPreAuth
      |
      v
    Authentication  -->  Payload Processing  -->  Payload Auth
      |
      v
    onCredentials  -->  Authorization  -->  onPostAuth
      |
      v
    Validate: headers, params, query, payload, state
      |
      v
    onPreHandler  -->  Pre-handler methods  -->  Route Handler
      |
      v
    onPostHandler  -->  Response Validation  -->  onPreResponse
      |
      v
    Response Transmission  -->  Finalize  -->  onPostResponse
```


### Execution Order


1. Extensions execute in the order they are added, unless modified by `before`/`after` options.
2. When `sandbox: 'plugin'` is used, the extension only applies to routes defined by that plugin.
3. Route-level extensions (defined in `route.options.ext`) execute after server-level extensions of the same type.
4. All request lifecycle methods must return a value or resolve a promise. Returning `undefined` causes a 500 error.
5. Return `h.continue` to proceed to the next step. Return any other value (including Boom errors) to short-circuit the lifecycle.

**Ordering between plugins:**

```js
    // In plugin A:
    server.ext('onPreHandler', methodA);

    // In plugin B -- ensure it runs before plugin A:
    server.ext('onPreHandler', methodB, { before: 'pluginA' });
```

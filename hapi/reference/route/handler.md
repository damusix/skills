## Route Handler (`route.options.handler`)


The handler performs the main business logic of the route. It can be defined at the top-level of the route config or inside `options`.

### Handler signature


    async function handler(request, h) {
        // request - the Request object
        // h - the Response toolkit
        return 'response value';
    }

### Return values


Handlers return a value that becomes the response:

| Return type | Behavior |
|-------------|----------|
| `string` | Text response with `text/html` content type |
| `object` / `array` | JSON-serialized with `application/json` content type |
| `Buffer` | Raw buffer with `application/octet-stream` content type |
| `Error` / `Boom` | Error response with appropriate status code |
| `Stream` | Piped as-is to the response |
| `null` | Empty response (status 204 by default, configurable via `response.emptyStatusCode`) |
| `h.response(value)` | Response object for further customization (headers, status code, etc.) |
| `h.redirect(uri)` | Redirect response |

    server.route({
        method: 'GET',
        path: '/user/{id}',
        handler: async function (request, h) {

            const user = await getUser(request.params.id);

            if (!user) {
                throw Boom.notFound('User not found');
            }

            return h.response(user).code(200).header('X-Custom', 'value');
        }
    });

### Handler as lifecycle method


The handler is a standard lifecycle method. It can be `async`, return a promise, or return a value synchronously.

    // Sync
    handler: (request, h) => 'ok'

    // Async
    handler: async (request, h) => {

        const data = await fetchData();
        return data;
    }

    // Takeover -- bypasses later lifecycle steps
    handler: (request, h) => {

        return h.response('raw').takeover();
    }

### Handler decoration (registered handlers)


A handler can be an object with a single property matching a handler type registered via `server.decorate('handler', name, method)`. The property value is passed as options to the handler generator.

    // Register a handler type
    server.decorate('handler', 'timer', function (route, options) {

        return function (request, h) {

            const start = Date.now();
            return { ms: Date.now() - start, message: options.message };
        };
    });

    // Use in route -- the key 'timer' must match the registered name
    server.route({
        method: 'GET',
        path: '/timer',
        handler: { timer: { message: 'hello' } }
    });

### `this` binding via `route.options.bind`


Default: `null`.

An object passed as `this` context to the handler (and extension methods). Ignored if the handler is an arrow function.

    server.route({
        method: 'GET',
        path: '/bound',
        options: {
            bind: { greeting: 'Hello' },
            handler: function (request, h) {

                // Arrow functions cannot access this binding
                return this.greeting + ' World';
            }
        }
    });

For arrow function handlers, access bind context via `h.context`:

    server.route({
        method: 'GET',
        path: '/arrow',
        options: {
            bind: { greeting: 'Hello' },
            handler: (request, h) => h.context.greeting + ' World'
        }
    });

### Gotchas


- Arrow function handlers **cannot** use `this` binding. Use `h.context` instead.
- Throwing an error inside a handler (or returning a rejected promise) triggers the `onPreResponse` extension with the error, which can be caught and modified.
- Handler decoration objects must have exactly one property matching a registered handler name.
- The handler is called after authentication, validation, and all `pre` methods have completed.

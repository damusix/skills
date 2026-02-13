## Route Pre-handler Methods (`route.options.pre`)


Default: none.

Pre-handler methods run before the handler, allowing you to break logic into reusable components and handle prerequisite operations (e.g., loading data from a database).

### Structure


`pre` is an ordered array. Elements are executed **serially** in order. If an element is itself an array, those methods run **in parallel**.

    pre: [
        methodA,                    // runs first (serial)
        [methodB, methodC],         // then B and C run in parallel
        methodD                     // then D runs after B and C complete
    ]

### Pre element formats


Each element in the `pre` array can be:

| Format                             | Description                                          |
| ---------------------------------- | ---------------------------------------------------- |
| `function`                         | Lifecycle method. Shorthand for `{ method: fn }`.    |
| `{ method, assign?, failAction? }` | Full pre object.                                     |
| `[...]`                            | Array of pre objects/functions executed in parallel. |

### Pre object properties


| Property     | Default    | Description                                                               |
| ------------ | ---------- | ------------------------------------------------------------------------- |
| `method`     | (required) | Lifecycle method: `async function(request, h)`.                           |
| `assign`     | none       | Key name to store the result in `request.pre` and `request.preResponses`. |
| `failAction` | `'error'`  | `failAction` value: `'error'`, `'log'`, `'ignore'`, or function.          |

### Full example


    const loadUser = async function (request, h) {

        const user = await db.user.get(request.params.id);
        if (!user) {
            throw Boom.notFound('User not found');
        }

        return user;
    };

    const loadPermissions = async function (request, h) {

        return await db.permissions.get(request.params.id);
    };

    const formatResponse = function (request, h) {

        return {
            ...request.pre.user,
            permissions: request.pre.perms
        };
    };

    server.route({
        method: 'GET',
        path: '/user/{id}',
        options: {
            pre: [
                [
                    { method: loadUser, assign: 'user' },
                    { method: loadPermissions, assign: 'perms' }
                ],
                { method: formatResponse, assign: 'result' }
            ],
            handler: function (request, h) {

                return request.pre.result;
            }
        }
    });

Execution flow:
1. `loadUser` and `loadPermissions` run in parallel
2. `formatResponse` runs after both complete (has access to `request.pre.user` and `request.pre.perms`)
3. Handler runs last

### Accessing pre results


| Property               | Contains                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `request.pre`          | The **return values** of pre methods, keyed by `assign` name.        |
| `request.preResponses` | The **response objects** (including errors), keyed by `assign` name. |

    handler: function (request, h) {

        const user = request.pre.user;            // The returned value
        const resp = request.preResponses.user;    // The response toolkit object
        return user;
    }

### Key behavior: return values


Pre-handler methods behave differently from other lifecycle methods:

- **Return values do NOT become the response.** Instead, they are assigned to `request.pre[assign]`.
- Errors, takeover responses, and abort signals behave the same as in other lifecycle methods.

    // This assigns 'Hello' to request.pre.greeting -- it does NOT send 'Hello' as the response
    { method: (request, h) => 'Hello', assign: 'greeting' }

### Takeover in pre methods


A pre method can take over the response, skipping the handler entirely:

    {
        method: function (request, h) {

            if (request.query.cached) {
                return h.response('from cache').takeover();
            }

            return 'proceed';
        },
        assign: 'check'
    }

### failAction in pre methods


| Value      | Behavior                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| `'error'`  | Stop processing, return the error as the response (default).                           |
| `'log'`    | Log the error, assign the error to `request.pre[assign]` if `assign` is set, continue. |
| `'ignore'` | Silently ignore the error, assign it if `assign` is set, continue.                     |
| `function` | Custom error handler following the `failAction` function signature.                    |

    pre: [
        {
            method: async (request, h) => {

                // This might fail, but we want to continue
                return await cache.get(request.params.id);
            },
            assign: 'cached',
            failAction: 'log'
        }
    ]

When `failAction` is not `'error'` and `assign` is set, the error object is assigned to `request.pre[assign]`.

### Parallel execution behavior


During parallel execution, if any method errors, returns a takeover, or aborts:
- Other parallel methods **continue to execute** but their results are **ignored** once completed.
- The error/takeover/abort takes effect immediately after all parallel methods finish.

### Gotchas


- Without `assign`, the pre method's return value is discarded (no way to access it).
- Pre methods without `assign` are still useful for side effects (e.g., logging, authorization checks).
- The `pre` array is not merged between server defaults and route config -- route-level replaces entirely.
- Pre methods run after authentication **and** all validation (headers, params, query, payload, state). They execute during the pre-handler phase, between `onPreHandler` and the route handler.

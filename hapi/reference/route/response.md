## Route Response Options (`route.options.response`)


Processing rules for the outgoing response.

### All response options


| Option                 | Default   | Description                                                                |
| ---------------------- | --------- | -------------------------------------------------------------------------- |
| `emptyStatusCode`      | `204`     | Status code for empty payloads: `200` or `204`.                            |
| `failAction`           | `'error'` | What to do when response validation fails. Returns 500 on error.           |
| `modify`               | `false`   | If `true`, apply validation changes to the response payload.               |
| `options`              | none      | Options passed to joi or custom validation functions.                      |
| `ranges`               | `true`    | If `false`, disable payload range (partial content) support.               |
| `sample`               | `100`     | Percent of responses to validate (0-100). `0` disables validation.         |
| `schema`               | `true`    | Default response validation schema.                                        |
| `status`               | none      | Per-status-code validation schemas.                                        |
| `disconnectStatusCode` | `499`     | Status code for logging when client disconnects before response completes. |

### `emptyStatusCode`


When the response payload is empty (e.g., `null` return or empty string), hapi uses this status code at transmission time. The `response.statusCode` remains `200` throughout the lifecycle unless manually changed.

    response: {
        emptyStatusCode: 200    // Send 200 instead of 204 for empty responses
    }

### `schema` (response validation)


Validates non-error response payloads. Accepts:

| Value                            | Behavior                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `true`                           | Any payload allowed (default, no validation).                                                          |
| `false`                          | No payload allowed.                                                                                    |
| joi schema                       | Validate against the schema. Context includes `{ headers, params, query, payload, state, app, auth }`. |
| `async function(value, options)` | Custom validation function.                                                                            |

    const Joi = require('joi');

    server.route({
        method: 'GET',
        path: '/user/{id}',
        options: {
            response: {
                schema: Joi.object({
                    id: Joi.number().required(),
                    name: Joi.string().required(),
                    email: Joi.string().email().required()
                }),
                failAction: 'log'    // Log but don't block the response
            },
            handler: async (request, h) => {

                return await getUser(request.params.id);
            }
        }
    });

### `modify`


When `true`, the validated (and possibly transformed) value replaces the response payload:

    response: {
        modify: true,
        schema: Joi.object({
            name: Joi.string().required()
        }).options({ stripUnknown: true }),    // Strips extra fields from response
        options: { stripUnknown: true }
    }

If the original response is an error, the return value overrides `error.output.payload`.

### `status` (per-status-code validation)


Validate responses differently based on HTTP status code. Responses not matching any listed status code fall through to the default `schema`.

    response: {
        status: {
            200: Joi.object({
                id: Joi.number(),
                name: Joi.string()
            }),
            201: Joi.object({
                id: Joi.number(),
                created: Joi.boolean()
            })
        }
    }

### `sample`


Useful in production to reduce validation overhead:

    response: {
        schema: Joi.object({ ... }),
        sample: 10    // Only validate 10% of responses
    }

Set to `0` to disable all validation. Set to `100` (default) to validate everything.

### `failAction`


| Value                               | Behavior                                      |
| ----------------------------------- | --------------------------------------------- |
| `'error'`                           | Return 500 Internal Server Error (default).   |
| `'log'`                             | Log the error but send the original response. |
| `'ignore'`                          | Silently ignore validation failure.           |
| `async function(request, h, error)` | Custom handler.                               |

    response: {
        schema: Joi.object({ ... }),
        failAction: async function (request, h, err) {

            // Log details in development, return generic error in production
            request.log(['error', 'response', 'validation'], err.message);
            throw Boom.badImplementation('Response validation failed');
        }
    }

### `options`


Passed to joi or to custom validation functions as the second argument. The request context (`headers`, `params`, `query`, `payload`, `state`, `app`, `auth`) is also merged in.

    response: {
        options: {
            stripUnknown: true,
            abortEarly: false
        },
        schema: Joi.object({ ... })
    }

### `ranges`


Controls HTTP Range header support for partial content responses:

    response: {
        ranges: false    // Disable Range request support for this route
    }

### `disconnectStatusCode`


The status code used for logging when a client closes the connection before the response is fully transmitted. Only used for logging purposes since the request has already ended.

    response: {
        disconnectStatusCode: 499    // Default, based on nginx convention
    }

Value must be >= 400.

### Custom validation function


    response: {
        modify: true,
        schema: async function (value, options) {

            // value = pending response payload
            // options = response.options + request context

            if (value.sensitive) {
                delete value.sensitive;
            }

            return value;    // Used as new response if modify is true
        }
    }

### Gotchas


- Response validation only applies to **non-error** responses unless you use `modify: true` (which can also override error payloads).
- The `sample` percentage is applied randomly per request, not as a fixed rotation.
- Setting `failAction` to `'log'` is useful in production to catch schema drift without breaking responses.
- The `emptyStatusCode` conversion from 200 to 204 happens at transmission time, not during the lifecycle.

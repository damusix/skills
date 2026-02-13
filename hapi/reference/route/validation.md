## Route Validation (`route.options.validate`)


Default: `{ headers: true, params: true, query: true, payload: true, state: true, failAction: 'error' }`.

Validates incoming request components using joi schemas, custom functions, or booleans.

### All validation properties


| Property      | Default   | Description                                                             |
| ------------- | --------- | ----------------------------------------------------------------------- |
| `headers`     | `true`    | Validate `request.headers`.                                             |
| `params`      | `true`    | Validate `request.params`.                                              |
| `query`       | `true`    | Validate `request.query`.                                               |
| `payload`     | `true`    | Validate `request.payload`.                                             |
| `state`       | `true`    | Validate `request.state` (cookies).                                     |
| `failAction`  | `'error'` | How to handle validation failures.                                      |
| `options`     | none      | Options object passed to joi or custom validation functions.            |
| `errorFields` | none      | Object with fields copied into every validation error response.         |
| `validator`   | `null`    | Server validation module to compile raw rules into schemas (e.g., joi). |

### Validation order


Validation runs in this fixed order:

1. `headers`
2. `params`
3. `query`
4. `payload`
5. `state`

If type casting occurs (e.g., string to number), inputs not yet validated still contain raw, unmodified values.

### Validation value types


Each of `headers`, `params`, `query`, `payload`, and `state` accepts:

| Value                            | Behavior                              |
| -------------------------------- | ------------------------------------- |
| `true`                           | No validation (anything allowed).     |
| `false`                          | Nothing allowed (payload/query only). |
| joi schema                       | Validate against the schema.          |
| `async function(value, options)` | Custom validation function.           |

### Using joi schemas


    const Joi = require('joi');

    server.route({
        method: 'POST',
        path: '/user/{id}',
        options: {
            validate: {
                params: Joi.object({
                    id: Joi.number().integer().required()
                }),
                payload: Joi.object({
                    name: Joi.string().min(1).max(100).required(),
                    email: Joi.string().email().required()
                }),
                query: Joi.object({
                    verbose: Joi.boolean().default(false)
                })
            },
            handler: function (request, h) {

                // request.params.id is now a number (type-cast by joi)
                // request.query.verbose is a boolean with default
                return 'ok';
            }
        }
    });

### Context object for joi references


The validation `options.context` is automatically populated with the other request inputs. Access them in joi rules with `Joi.ref('$...')`:

| Context key | Source            |
| ----------- | ----------------- |
| `$headers`  | `request.headers` |
| `$params`   | `request.params`  |
| `$query`    | `request.query`   |
| `$payload`  | `request.payload` |
| `$state`    | `request.state`   |
| `$app`      | `request.app`     |
| `$auth`     | `request.auth`    |

    validate: {
        payload: Joi.object({
            min: Joi.number().required(),
            max: Joi.number().greater(Joi.ref('min')).required()
        }),
        query: Joi.object({
            token: Joi.string().valid(Joi.ref('$headers.x-api-key'))
        })
    }

### Custom validation functions


    validate: {
        payload: async function (value, options) {

            // value = request.payload
            // options = route validate.options + context

            if (!value.name) {
                throw Boom.badRequest('Missing name');
            }

            // Return a value to replace request.payload
            // Original stored in request.orig.payload
            return { ...value, name: value.name.trim() };

            // Or return nothing to leave payload unchanged
        }
    }

### `failAction`


Controls what happens when validation fails. Applies to all validated inputs unless overridden.

| Value                               | Behavior                                        |
| ----------------------------------- | ----------------------------------------------- |
| `'error'`                           | Return 400 Bad Request (default).               |
| `'log'`                             | Log the error and continue with original value. |
| `'ignore'`                          | Silently ignore the error and continue.         |
| `async function(request, h, error)` | Custom error handler.                           |

    validate: {
        failAction: async function (request, h, err) {

            // err.output.payload.validation.source tells you which input failed
            // err.data.defaultError contains the default error that would be returned

            if (process.env.NODE_ENV === 'production') {
                throw Boom.badRequest('Invalid request');
            }

            // In development, return the full error
            throw err;
        }
    }

### `errorFields`


Extra fields merged into every validation error response:

    validate: {
        errorFields: { timestamp: Date.now() },
        payload: Joi.object({ name: Joi.string().required() })
    }

    // Error response will include:
    // { statusCode: 400, error: 'Bad Request', message: '...', timestamp: 1234567890 }

### `options`


Passed to joi (or to custom validation functions as the second argument):

    validate: {
        options: {
            abortEarly: false,      // Return all errors, not just the first
            stripUnknown: true,     // Remove unknown keys
            allowUnknown: false     // Reject unknown keys (default)
        },
        payload: Joi.object({
            name: Joi.string().required()
        })
    }

### `validator`


Sets a server validation module to compile raw validation rules into schemas. Only used when rules are not already compiled schemas.

    validate: {
        validator: require('joi')
    }

When a validation rule is already a function or joi schema object, the validator is bypassed.

### Null payload handling


Empty payloads are `null`. If you have a schema and want to allow empty payloads:

    validate: {
        payload: Joi.object({
            name: Joi.string()
        }).allow(null)
    }

### Header validation note


All header field names must be **lowercase** to match Node.js normalized headers:

    validate: {
        headers: Joi.object({
            'x-custom-header': Joi.string().required()
        }).unknown(true)    // Allow other headers through
    }

### Route-level vs server-level


Validation rules defined at the route level **override** server defaults (they are NOT merged). If you define `validate.params` on both the server and route, the route's `validate.params` wins entirely.

### Gotchas


- Failing to match `params` validation to your route's path parameters will cause **all requests** to fail.
- Validating large payloads with modifications causes memory duplication (original is kept in `request.orig`).
- Changes to `query` via validation will NOT be reflected in `request.url`.
- When using type casting (e.g., `Joi.number()`), earlier-validated inputs are cast but later ones are still raw strings.

## Validation


### `schema.validate(value, [options])`


Validates a value synchronously and returns `{ error, value, warning, debug, artifacts }`.

    const schema = Joi.string().min(3);

    const { error, value } = schema.validate('ab');
    // error.message: '"value" length must be at least 3 characters long'

    const { value: clean } = schema.validate('hello');
    // clean: 'hello'

The returned `value` includes any type coercions and defaults applied during validation.

Properties on the result object:
- `error` - a `ValidationError` if validation failed, otherwise `undefined`
- `value` - the validated (and possibly coerced/defaulted) value
- `warning` - a `ValidationError`-like object with `details` array if warnings were generated, otherwise `undefined`
- `debug` - an array of debug entries when `debug: true` is set, otherwise `undefined`
- `artifacts` - a `Map` of artifact values to arrays of paths when `artifacts: true` is set, otherwise `undefined`

Important: The `warnings` and `artifacts` options **cannot** be set via the options argument of synchronous `validate()`. They can only be set via schema-level `.prefs()`. Attempting to pass them throws an assertion error. The `debug` option can be set on synchronous calls.


### `schema.validateAsync(value, [options])`


Returns a Promise. Required when using `.external()` validators.

    const schema = Joi.string().external(async (value) => {
        const exists = await db.lookup(value);
        if (!exists) {
            throw new Error('Not found');
        }
    });

    const value = await schema.validateAsync(input);

**Return value depends on options:**
- By default (no `warnings`, `debug`, or `artifacts` options), resolves with just the validated value directly.
- When any of `warnings: true`, `debug: true`, or `artifacts: true` is set, resolves with an object `{ value, warning, debug, artifacts }` (only populated keys present).

**On error**, the promise rejects with a `ValidationError` (it does **not** return `{ error }` like the sync version). If debug mode is enabled, the `debug` array is attached to the error object as `error.debug`.

    // Returns plain value
    const val = await schema.validateAsync(input);

    // Returns object with value + warning
    const { value, warning } = await schema.validateAsync(input, { warnings: true });

    // Returns object with value + debug
    const { value, debug } = await schema.validateAsync(input, { debug: true });


### `Joi.assert(value, schema, [message], [options])`


Validates and throws on error. Returns nothing. Uses annotated error messages (calls `error.annotate()`).

    Joi.assert('hello', Joi.string().min(3));           // ok
    Joi.assert(5, Joi.string(), 'Custom prefix');       // throws
    Joi.assert(5, Joi.string(), new Error('bail'));      // throws the provided Error

When `message` is a string, it is prepended to the validation error message. When `message` is an `Error` object, that error is thrown directly (ignoring the validation error details). The `errors.stack` option is always forced to `true` internally.


### `Joi.attempt(value, schema, [message], [options])`


Validates, throws on error, returns validated value. Same error behavior as `Joi.assert()` but returns the validated `result.value` on success.

    const result = Joi.attempt('hello', Joi.string().min(3));
    // result: 'hello'

    const result = Joi.attempt({ name: 'jo' }, Joi.object({
        name: Joi.string().min(3)
    }));
    // throws ValidationError


### Validation Options


Pass as second argument to `validate()`, `validateAsync()`, `assert()`, or `attempt()`.

| Option              | Default      | Description                                                    |
| ------------------- | ------------ | -------------------------------------------------------------- |
| `abortEarly`        | `true`       | Stop on first error                                            |
| `allowUnknown`      | `false`      | Allow unknown object keys                                      |
| `artifacts`         | `false`      | Collect artifacts from `schema.artifact()`. Sync: schema-level only |
| `cache`             | `true`       | Enable schema caching (only for schemas without refs)          |
| `context`           | `null`       | External context for `Joi.ref('$key')`                         |
| `convert`           | `true`       | Coerce types (string to number, etc.) and run prepare/coerce steps |
| `dateFormat`        | `'iso'`      | Date output: `'date'`, `'iso'`, `'string'`, `'time'`, `'utc'` |
| `debug`             | `false`      | Enable debug mode (returns debug log on result)                |
| `errors.escapeHtml` | `false`      | Escape HTML in error messages                                  |
| `errors.label`      | `'path'`     | Controls label in messages: `'path'` (full path), `'key'` (last key only), `false` (no label) |
| `errors.language`   | `null`       | Language code for selecting message templates                   |
| `errors.render`     | `true`       | Render error templates into messages. When `false`, returns raw template strings |
| `errors.stack`      | `false`      | Include stack trace in errors                                  |
| `errors.wrap`       | see below    | Characters used to wrap labels and values in messages           |
| `externals`         | `true`       | Execute external validations (requires `validateAsync()`)      |
| `messages`          | `{}`         | Custom validation messages (merged with schema-level messages)  |
| `noDefaults`        | `false`      | Skip applying `default()` and `failover()` values              |
| `nonEnumerables`    | `false`      | Validate non-enumerable properties on objects                  |
| `presence`          | `'optional'` | Default presence: `'optional'`, `'required'`, `'forbidden'`    |
| `skipFunctions`     | `false`      | Skip validation of function-typed object keys                  |
| `stripUnknown`      | `false`      | Remove unknown keys. `{ objects: true, arrays: true }` for granular |
| `warnings`          | `false`      | Collect warnings in result. Sync: schema-level only            |

#### `errors.wrap`

Controls wrapping characters in error messages. Defaults:

    {
        errors: {
            wrap: {
                label: '"',     // Wraps labels: "value", "name"
                array: '[]'     // Wraps array values: [a, b, c]
            }
        }
    }

Set `label: false` to remove quotes around labels in messages. Set `array: false` to disable brackets around array values in messages. The `array` value must be a two-character string (open and close) or `false`.

#### `stripUnknown`

When set to `true`, strips unknown keys from objects. For granular control:

    {
        stripUnknown: {
            objects: true,    // Strip unknown object keys
            arrays: true      // Strip unknown array items (items not matching any schema)
        }
    }

#### `errors.label`

Controls how the `{#label}` placeholder is populated in error messages:

- `'path'` (default) - uses the full dotted path: `"a.b.c"`
- `'key'` - uses only the last key in the path: `"c"`
- `false` - no label; the leading `"" ` prefix is stripped from messages


### Validation Pipeline


The internal validation pipeline processes a value through these steps in order:

1. **When conditions** - resolve any `.when()` conditions to produce the final schema
2. **Preferences** - merge schema-level `.prefs()` into active options
3. **Cache** - return cached result if available (only schemas without refs)
4. **Prepare** - type-specific preparation (e.g. string trimming). Runs only if `convert: true` and value is not `undefined`. Prepare errors always abort early.
5. **Coerce** - type coercion (e.g. string to number). Runs only if `convert: true` and value is not `undefined`. Coercion errors always abort early.
6. **Empty** - if `schema.empty()` is set and value matches the empty schema, value becomes `undefined`. If a `trim` rule is active, strings are trimmed before the empty match check.
7. **Presence** - check `required`, `optional`, `forbidden` flags. If value is `undefined` and `optional`, returns immediately (unless deep default). If value is defined and `forbidden`, generates `any.unknown` error.
8. **Valid (allow)** - check `schema.valid()` values. If matched and `convert: true`, the value may be replaced with the canonical valid value. If `only` flag is set and no match, generates `any.only` error.
9. **Invalid (deny)** - check `schema.invalid()` values. If matched, generates `any.invalid` error.
10. **Base type** - type-specific validation (e.g. object key validation, array item validation). Base errors always abort early.
11. **Rules** - runs each rule added via type methods (e.g. `.min()`, `.max()`, `.pattern()`). Rules with `warn: true` produce warnings instead of errors. Rules that were already applied during coerce step are skipped.
12. **Finalize** - applies in order:
    - **Failover** - if errors exist and `failover()` is set, replaces value and clears errors
    - **Error override** - if `.error()` is set, replaces error reports
    - **Default** - if value is `undefined` and `default()` is set (and `noDefaults` is false), applies the default
    - **Cast** - applies `.cast()` transformation if value is not `undefined`
    - **Externals** - queues any `.external()` methods for later async execution
    - **Result** - applies `strip` or `raw` result flags
    - **Cache** - stores result in cache (only for schemas without refs)
    - **Artifacts** - collects artifact if value is defined and no errors


### Externals


External validators run **after** the entire synchronous validation pipeline completes, during `validateAsync()` only.

    const schema = Joi.string().external(async (value, helpers) => {
        // value: the validated value at this point
        // helpers: { schema, linked, state, prefs, original, error, errorsArray, warn, message }
        const exists = await db.lookup(value);
        if (!exists) {
            throw new Error('Not found');
        }

        return value;  // Return replacement value, or undefined/same value to keep
    });

The `helpers` object passed to external methods:

| Property      | Description                                                                |
| ------------- | -------------------------------------------------------------------------- |
| `schema`      | The schema that defined the external                                       |
| `linked`      | The resolved linked schema if the schema type is `'link'`, otherwise `null` |
| `state`       | The validation state at the external's position                            |
| `prefs`       | The original prefs passed to `validateAsync()`                             |
| `original`    | The original (pre-validation) value at the same path                       |
| `error`       | `(code, local) => Report` - creates a typed validation error               |
| `errorsArray` | `() => []` - creates a special errors array for returning multiple errors  |
| `warn`        | `(code, local) => void` - adds a warning                                   |
| `message`     | `(messages, local) => Report` - creates a custom error with message templates |

Key behaviors:
- Externals execute **sequentially** in the order they were queued (depth-first through the schema tree).
- Returning `undefined` or the same value keeps the current value unchanged.
- Returning a different value replaces the value in the result tree.
- Returning an `Errors.Report` (from `helpers.error()`) is treated as a validation error.
- Returning an errors array (from `helpers.errorsArray()`) reports multiple errors.
- Throwing an error propagates the error directly (with the schema label appended to the message when `errors.label` is set).
- `abortEarly` applies to external errors -- processing stops after the first external error if enabled.
- If `externals: false` is set in options, external methods are skipped entirely.
- Using `.external()` with synchronous `validate()` throws an assertion error.


### Warnings


Warnings are non-fatal validation messages. They appear when:
- A rule uses `.warn()` mode: `Joi.string().min(3).warn()`
- An external calls `helpers.warn(code, local)`

    const schema = Joi.string().min(3).warning('custom.warning', { limit: 3 });

    // Synchronous - warnings available via schema-level prefs only
    const schema2 = Joi.string().min(3).warn().prefs({ warnings: true });
    const { value, warning } = schema2.validate('ab');
    // warning.details[0].type === 'string.min'

    // Async
    const { value, warning } = await schema.validateAsync('ab', { warnings: true });

The `warning` property is a `ValidationError`-like object with a `details` array, same structure as `error.details`. It is only present when warnings were actually generated.


### Artifacts


Artifacts let you tag schemas and collect which paths matched:

    const schema = Joi.object({
        name: Joi.string().artifact('field_name'),
        age: Joi.number().artifact('field_age')
    });

    const { value, artifacts } = schema.validate(
        { name: 'Jo', age: 25 },
        // For sync: must use schema.prefs({ artifacts: true }).validate(...)
    );
    // artifacts: Map { 'field_name' => [['name']], 'field_age' => [['age']] }

The `artifacts` result is a `Map` where keys are the artifact values and values are arrays of paths (each path is an array of segments). Artifacts are only collected for values that are defined and pass validation (no errors).


### Debug Mode


Returns a `debug` array with trace entries for the validation run:

    const { value, debug } = await schema.validateAsync(input, { debug: true });

    // Sync
    const { debug } = schema.validate(input, { debug: true });

Each debug entry has a `type` and `path` property. Types include `'entry'`, `'validate'`, `'resolve'`, and rule-specific logs. Debug requires the `@hapi/lab` trace module to be available (`schema.$_root.trace` must exist).


### Cache Behavior


When `cache: true` (default), joi caches validation results for schemas that have no references (`schema._refs.length === 0`). On cache hit, the cached result is returned immediately (skipping the entire pipeline). Results are stored keyed by the original input value.

Caching is only effective for simple schemas without dynamic references, as refs would produce different results for different contexts.


### Schema-Level Preferences


Use `.prefs()` (alias `.options()`, `.preferences()`) to set options on a schema:

    const schema = Joi.object({
        name: Joi.string()
    }).prefs({ abortEarly: false, stripUnknown: true });

Schema-level preferences are merged with (and override) validation-call options. Nested schemas can have their own preferences that further override the parent.

This is the **only** way to enable `warnings` and `artifacts` collection for synchronous `validate()` calls:

    const schema = Joi.string().min(3).warn().prefs({ warnings: true });
    const { value, warning } = schema.validate('ab');


### Context


External values accessible via `$` references:

    const schema = Joi.object({
        max: Joi.number().max(Joi.ref('$serverMax'))
    });

    schema.validate({ max: 500 }, { context: { serverMax: 1000 } });

Context is set via the `context` option and accessed in schemas using `Joi.ref('$key')`. The context object is shared across the entire validation run.

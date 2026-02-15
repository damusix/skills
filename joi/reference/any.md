## Common Methods (any)


All schemas inherit these methods from `Joi.any()`.


### Value constraints

| Method                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.allow(...values)`          | Add allowed values (bypass type validation)        |
| `.valid(...values)`          | Only allow these values (alias `.equal()`)         |
| `.invalid(...values)`        | Deny these values (alias `.disallow()`, `.deny()`, `.not()`) |
| `.required()`                | Must be present and not undefined (alias `.exist()`) |
| `.optional()`                | May be undefined (default)                         |
| `.forbidden()`               | Must not be present                                |
| `.presence(mode)`            | Set presence directly: `'optional'`, `'required'`, `'forbidden'` |
| `.only(mode)`                | If `true`, only values in `.allow()` list are valid (set automatically by `.valid()`) |
| `.strip(enabled?)`           | Remove from validated output (default `true`)      |
| `.result(mode)`              | Set result mode: `'raw'` or `'strip'`              |

Special values for `.allow()`, `.valid()`, `.invalid()`:

    Joi.any().valid(null)            // Allow null
    Joi.any().valid(Joi.ref('x'))    // Dynamic valid value
    Joi.any().valid(Joi.override, 'a', 'b')  // Replace parent valid list

`Joi.override` as the first argument replaces inherited values instead of appending.

`.valid()` calls `.allow()` then sets the `only` flag. `.invalid()` removes from valids if present.


### Defaults & coercion

| Method                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.default(value, [options])` | Default when undefined. `options.literal` wraps functions as literal values |
| `.default(fn)`               | Lazy default via function (called at validation time) |
| `.failover(value, [options])`| Use when validation fails (same signature as `.default()`) |
| `.empty(schema)`             | Treat matching values as undefined. Pass `undefined` to reset |
| `.cast(to)`                  | Cast output type. Pass `false` to remove cast      |
| `.raw(enabled?)`             | Return original value (skip coercion output). Default `true` |

`.empty()` compiles its argument as a schema. When both schemas in a `.concat()` have `.empty()`, they are concatenated together.

    Joi.string().empty('').default('N/A');  // '' → undefined → 'N/A'
    Joi.string().default(() => uuid());     // Lazy default
    Joi.string().default(fn, { literal: true });  // fn IS the default, not called

Cast options per type:

| Type        | Cast targets                   |
| ----------- | ------------------------------ |
| `array`     | `'set'`                        |
| `boolean`   | `'number'`, `'string'`         |
| `date`      | `'number'`, `'string'`         |
| `number`    | `'string'`                     |
| `object`    | `'map'`                        |
| `binary`    | `'string'`                     |


### Conditionals

| Method                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.when(ref, options)`        | Conditional schema (see [conditionals](conditionals.md)) |


### Metadata

| Method                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.label(name)`               | Set field label for error messages                 |
| `.description(desc)`         | Schema description (non-empty string)              |
| `.note(...notes)`            | Notes (variadic non-empty strings, appended)       |
| `.tag(...tags)`              | Tags (variadic non-empty strings, appended)        |
| `.meta(obj)`                 | Arbitrary metadata (appended to `metas` array)     |
| `.example(example, [options])` | Example value. `options.override` replaces list  |
| `.unit(name)`                | Unit name (e.g., `'ms'`, `'px'`)                   |
| `.id(id)`                    | Schema ID for `.extract()` and `.link('#id')`. Cannot contain `.` |

Note: The method names are `.note()` and `.tag()` (not `.notes()` and `.tags()`).


### Error customization

| Method                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.messages(messages)`        | Override error message templates (set via `.prefs()`) |
| `.message(message)`          | Override message for last rule only (via `.rule()`) |
| `.error(err)`                | Replace entire error (Error object or function)    |
| `.warning(code, [local])`    | Emit warning instead of error (added as rule with `warn: true`) |

`.message(message)` is a shortcut for `.rule({ message })`. `.warning()` is a rule (multi: true) that adds a warning code.


### Behavior modifiers

| Method                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.prefs(options)`            | Set validation preferences (alias `.options()`, `.preferences()`) |
| `.strict(enabled?)`          | Shortcut for `.prefs({ convert: false })`. `strict(false)` re-enables convert |
| `.custom(fn, [description])` | Custom validation function (multi: true, can add multiple) |
| `.external(fn, [description])` | Async external validation (requires `validateAsync()`) |
| `.artifact(value)`           | Attach artifact collected during validation. Cannot be `undefined`. Cannot combine with `.cache()` |
| `.cache(cache?)`             | Enable rule caching. Cannot combine with `.artifact()` |

#### `.custom(fn, [description])`

The function signature is `fn(value, helpers)`. Return a value to replace, return `undefined` to keep, or throw to fail. The `helpers` object provides `error(code, local)`, `state`, `prefs`, `schema`, and `original`.

    Joi.string().custom((value, helpers) => {
        if (value === 'bad') {
            return helpers.error('any.invalid');
        }

        return value.toUpperCase();
    }, 'uppercase validation');

Custom is a rule with `multi: true`, so multiple `.custom()` calls stack (they do not replace each other).

#### `.external(fn, [description])`

External validations run after all other validations succeed. They are async and require `validateAsync()`. The function receives `(value, helpers)`. Can also pass an object: `{ method, description }`.

    Joi.string().external(async (value, helpers) => {
        const exists = await db.exists(value);
        if (!exists) {
            return helpers.error('any.invalid');
        }
    }, 'db check');

    // Object form
    Joi.string().external({
        method: async (value) => { ... },
        description: 'db check'
    });

External functions are stored in `$_terms.externals` as `{ method, description }` objects.


### Schema composition

| Method                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.concat(schema)`            | Merge two schemas of compatible types              |
| `.alter(targets)`            | Named alternatives (used with `.tailor()`)         |
| `.tailor(targets)`           | Apply named alter(s). Accepts string or array      |
| `.fork(paths, adjuster)`     | Modify specific keys in object schema              |
| `.extract(path)`             | Get nested schema by key path or `.id()`           |

#### `.concat(schema)`

Merges `source` schema into the current schema. Limitations:
- Types must match, or one must be `any` (any adopts the other's type)
- Neither schema can have an open ruleset
- Single (non-multi) rules in source replace same-named rules in target (unless `keep` is set)
- Both `_valids` and `_invalids` are merged (cross-removed)
- If both have `.empty()`, the empty schemas are concatenated
- Terms (arrays) are concatenated
- Flags are merged (source wins)

    const base = Joi.string().min(1);
    const extended = base.concat(Joi.string().max(100));

#### `.alter(targets)`

Takes an object where keys are target names and values are adjuster functions `(schema) => schema`:

    const schema = Joi.object({
        name: Joi.string()
            .alter({
                create: (s) => s.required(),
                update: (s) => s.optional()
            })
    });

    schema.tailor('create');  // name becomes required
    schema.tailor('update');  // name becomes optional

#### `.extract(path)`

Extracts nested schema by path. Path can be a dot-separated string or array. Lookup checks `.id()` first, then key name:

    const schema = Joi.object({
        user: Joi.object({
            name: Joi.string().id('userName')
        })
    });

    schema.extract('user.name');      // By key path
    schema.extract(['user', 'name']); // Array path form


### Ruleset & rule modifiers

| Method / Getter              | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.ruleset` / `.$`            | Start a new ruleset (marks current rule position)  |
| `.rule(options)`             | Apply modifiers to rules in the current ruleset    |

`.ruleset` (or `.$`) marks the start position. Subsequent rules are part of the set. `.rule(options)` then applies modifiers to all rules in the set:

    Joi.number().$.min(0).max(100).rule({ message: 'Must be 0-100' });

Available rule modifiers (defined in `any` type):

| Modifier     | Description                                        |
| ------------ | -------------------------------------------------- |
| `keep`       | `true` to prevent rule from being removed by `.concat()` or same-name replacement |
| `message`    | Custom error message for these rules               |
| `warn`       | `true` to make rules emit warnings instead of errors |


### Validation methods

| Method                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.validate(value, [options])` | Synchronous validation. Returns `{ value, error, warning }` |
| `.validateAsync(value, [options])` | Async validation. Returns `Promise`. Required for `.external()` |


### Introspection

| Method                       | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `.describe()`                | Return schema description object (manifest)        |
| `.isAsync()`                 | `true` if schema uses `.external()` (checks whens recursively) |

    const desc = Joi.string().min(3).describe();
    // { type: 'string', rules: [{ name: 'min', args: { limit: 3 } }] }


### `Joi.isSchema(value, [options])`


Returns `true` if the value is a joi schema.

    Joi.isSchema(Joi.string());  // true
    Joi.isSchema('hello');       // false


### `Joi.compile(schema, [options])`


Compiles various inputs into joi schemas:

| Input       | Result                                         |
| ----------- | ---------------------------------------------- |
| joi schema  | Returns as-is                                  |
| `{}`        | `Joi.object().keys({})`                        |
| primitives  | `Joi.any().valid(value)`                       |
| `RegExp`    | `Joi.string().regex(pattern)`                  |
| `[schemas]` | `Joi.alternatives().try(...)` if schemas, else `Joi.any().valid(...)` |


### Top-level Joi methods


| Method                           | Description                                    |
| -------------------------------- | ---------------------------------------------- |
| `Joi.isSchema(value)`            | `true` if value is a joi schema                |
| `Joi.isRef(value)`               | `true` if value is a joi reference             |
| `Joi.isExpression(value)`        | `true` if value is a joi template expression   |
| `Joi.isError(err)`               | `true` if err is a `ValidationError`           |
| `Joi.ref(...args)`               | Create a reference                             |
| `Joi.in(...args)`                | Create an in-reference (for arrays)            |
| `Joi.expression(...args)`        | Create a template expression (alias `Joi.x`)   |
| `Joi.override`                   | Symbol to replace inherited allow/valid/invalid |
| `Joi.build(description)`         | Rebuild schema from `.describe()` output       |
| `Joi.compile(schema, [options])` | Compile literals into schemas                  |
| `Joi.defaults(modifier)`         | Create Joi instance with default schema modifier |
| `Joi.extend(...extensions)`      | Create Joi instance with extended types        |
| `Joi.types()`                    | Object with all type constructors (includes aliases) |
| `Joi.assert(value, schema, [message], [options])` | Throw on validation failure |
| `Joi.attempt(value, schema, [message], [options])` | Return value or throw on failure |
| `Joi.checkPreferences(prefs)`    | Validate preferences object                    |
| `Joi.cache`                      | Cache provider for rule caching                |
| `Joi.ValidationError`            | The ValidationError class                      |
| `Joi.version`                    | Joi version string                             |

Shortcuts on root Joi that delegate to `Joi.any()`:

    Joi.allow(), Joi.custom(), Joi.disallow(), Joi.equal(), Joi.exist(),
    Joi.forbidden(), Joi.invalid(), Joi.not(), Joi.only(), Joi.optional(),
    Joi.options(), Joi.prefs(), Joi.preferences(), Joi.required(),
    Joi.strip(), Joi.valid(), Joi.when()

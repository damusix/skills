## References & Templates


### `Joi.ref(key, [options])`


Creates a reference to another value resolved at validation time. The `key` is a string that identifies the target value using dot-separated path segments (by default). The key is trimmed of whitespace before processing.

#### Reference types

| Prefix | Type    | `ancestor` | Resolves to                    | Example                          |
| ------ | ------- | ---------- | ------------------------------ | -------------------------------- |
| (none) | Value   | `1`        | Sibling key in parent object   | `Joi.ref('min')`                 |
| `.`    | Value   | `0`        | The current value (self)       | `Joi.ref('.')`                   |
| `.`    | Value   | `0`        | Own property of current value  | `Joi.ref('.length')`             |
| `..`   | Value   | `1`        | Parent object (same as no prefix) | `Joi.ref('..field')`          |
| `...`  | Value   | `2`        | Grandparent object             | `Joi.ref('...field')`            |
| `....` | Value   | `3`        | Great-grandparent object       | `Joi.ref('....field')`           |
| `/`    | Value   | `'root'`   | Validation root value          | `Joi.ref('/config.limit')`       |
| `$`    | Global  | N/A        | External context object        | `Joi.ref('$env.MAX')`            |
| `#`    | Local   | N/A        | Schema-local state (rule args) | `Joi.ref('#limit')` in messages  |

**Ancestor mapping details:**

- No prefix (e.g. `'a'`): `ancestor = 1` -- looks in the parent object (sibling reference)
- Single dot prefix (e.g. `'.'` or `'.a'`): `ancestor = 0` -- looks in the current value itself
- Double dot prefix (e.g. `'..a'`): `ancestor = 1` -- same as no prefix (parent)
- Triple dot prefix (e.g. `'...a'`): `ancestor = 2` -- grandparent
- Each additional dot adds one more ancestor level: `N` dots = `ancestor = N - 1`
- Root prefix `/`: `ancestor = 'root'` -- resolves from the topmost ancestor in the state

When `separator` is `false`, the key is treated as a literal single-segment path with no ancestor parsing. The `ancestor` defaults to `1` (parent).

#### Usage examples

    // Cross-field: max must be >= min
    Joi.object({
        min: Joi.number(),
        max: Joi.number().min(Joi.ref('min'))
    });

    // Self reference: use current value's own property
    Joi.object({
        x: Joi.array().when('.length', {
            is: 2,
            then: Joi.array().items(2),
            otherwise: Joi.array().items(7)
        })
    });

    // Self reference in messages
    Joi.number().min(10).message('{#label} is {[.]} and that is not good enough');

    // Own property reference
    Joi.object({ length: Joi.number().required() })
        .length(Joi.ref('.length'))
        .unknown();

    // Parent reference (.. is equivalent to no prefix for sibling)
    Joi.object({
        a: Joi.any(),
        a1: Joi.ref('a'),       // sibling (ancestor 1)
        a2: Joi.ref('..a')      // same thing explicitly
    });

    // Grandparent reference
    Joi.object({
        a: Joi.any(),
        b: {
            c: Joi.ref('...a')  // ancestor 2 (grandparent)
        }
    });

    // Deep ancestor reference (4 dots = ancestor 3)
    Joi.object({
        f: { g: Joi.any() },
        a: {
            b: {
                gx: Joi.ref('....f.g')  // ancestor 3
            }
        }
    });

    // Root reference
    Joi.object({
        limit: Joi.number(),
        nested: Joi.object({
            deep: Joi.object({
                count: Joi.number().max(Joi.ref('/limit'))
            })
        })
    });

    // Context reference
    Joi.number().max(Joi.ref('$serverLimit'));
    // Pass context: schema.validate(value, { context: { serverLimit: 100 } });

    // Nested context reference
    Joi.boolean().when('$x.y', { is: Joi.exist(), otherwise: Joi.forbidden() });

    // Ref as default value
    Joi.object({
        a: Joi.any().default(Joi.ref('b')),
        b: Joi.any()
    });

    // Ref mixed with literal values in .valid()
    Joi.object({
        a: Joi.number().valid(1, Joi.ref('b')),
        b: Joi.any()
    });

    // Ref in array context (references array item by index)
    Joi.array().ordered(Joi.number(), Joi.number().min(Joi.ref('0')));

    // Ref to array .length property
    Joi.object({
        x: Joi.array().items(Joi.number().valid(Joi.ref('length')))
    });

#### Reference options

| Option      | Type | Description                              |
| ----------- | ---- | ---------------------------------------- |
| `adjust`    | `function(value)` | Transform the resolved value before use. Cannot be combined with `map`. |
| `ancestor`  | `number \| 'root'` | Explicit ancestor level. `0` = self, `1` = parent, `2` = grandparent, etc. `'root'` = validation root. Cannot be combined with dot-prefix notation. |
| `in`        | `boolean` | Set internally by `Joi.in()`. Enables array member matching. |
| `iterables` | `boolean` | When `true`, allows traversing into Set and Map values during path resolution. Required when referencing values inside casted sets/maps. |
| `map`       | `Array<[from, to]>` | Map resolved values to replacements. If the resolved value matches a `from`, it is replaced with the corresponding `to`. Unmatched values pass through unchanged. Cannot be combined with `adjust`. |
| `prefix`    | `object` | Override the default prefix characters: `{ global: '$', local: '#', root: '/' }`. Set any to a different character. If a prefix character equals the separator, that prefix is ignored (treated as value type). |
| `render`    | `boolean` | When `true`, the ref is resolved and rendered as its value in error messages instead of showing `ref:path`. |
| `separator` | `string \| false` | Path separator character (default `'.'`). Must be a single character. Set to `false` to treat the entire key as a single literal path segment (disables dot-prefix ancestor parsing). |

    // Adjust: double the referenced value
    Joi.number().max(Joi.ref('base', { adjust: (v) => v * 2 }));

    // Map: convert enum to limits
    Joi.number().max(Joi.ref('tier', {
        map: [['basic', 100], ['premium', 1000]]
    }));

    // Custom separator
    Joi.ref('b/c', { separator: '/' });

    // Literal key with no path parsing
    Joi.ref('...a', { separator: false });  // looks for sibling key literally named "...a"

    // Literal key with explicit ancestor
    Joi.ref('...a', { separator: false, ancestor: 2 });  // grandparent's key "...a"

    // Custom prefix
    Joi.ref('@x', { prefix: { global: '@' } });  // same as Joi.ref('$x')
    Joi.ref('@a', { prefix: { root: '@' } });     // same as Joi.ref('/a')

    // Render option: show resolved value in error messages
    const ref = Joi.ref('a', { render: true });
    Joi.object({
        a: Joi.number(),
        b: Joi.number().min(ref)
    });
    // Error: "b" must be greater than or equal to 10
    // Without render: "b" must be greater than or equal to ref:a

    // Iterables: traverse into Set and Map
    Joi.object({
        a: {
            b: Joi.array()
                .items({ x: Joi.number(), y: Joi.object().cast('map') })
                .cast('set')
        },
        d: Joi.ref('a.b.2.y.w', { iterables: true })
    });

#### Resolution order

References resolve against the **already-validated** value. Joi reorders object keys so that referenced keys are validated before the keys that reference them. This means:

- The order keys are defined in the schema does not matter
- Referenced values reflect any coercion/casting applied during validation (e.g. string `'5'` coerced to number `5`)
- Circular references between sibling keys will throw at schema compilation time

#### Shadow values

When a value is stripped (e.g. via `.strip()`) or renamed, references can still resolve the original value through the shadow value system. The `_resolve` method checks `state.mainstay.shadow` before falling back to the live object.


### `Joi.in(key, [options])`


Like `Joi.ref()` but for matching within arrays. Creates a reference with `in: true`. Used with `.valid()` and `.invalid()` to check if the value is contained within the referenced array:

    Joi.object({
        roles: Joi.array().items(Joi.string()),
        primary: Joi.string().valid(Joi.in('roles'))
    });

When used with `render: true`, displays the array contents in error messages instead of the ref path:

    const ref = Joi.in('a', { render: true });
    // Error shows: "b" must be [1, 2, 3]


### Templates


Templates enable dynamic strings with embedded references and expressions. They are powered by `@hapi/formula` for expression parsing and evaluation.

#### `Joi.expression(template, [options])` (alias `Joi.x()`)

Creates a template object. The `options` parameter supports all ref options (like `separator`, `prefix`) plus a `functions` property for custom template functions.

    Joi.object({
        a: Joi.number(),
        b: Joi.number(),
        sum: Joi.number().valid(Joi.x('{a + b}'))
    });

#### Template syntax

| Syntax              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `{key}`             | Raw reference (no HTML escaping)               |
| `{{key}}`           | Reference with HTML escaping                   |
| `{#local}`          | Local rule context reference (raw)             |
| `{{#local}}`        | Local rule context reference (escaped)         |
| `{$context}`        | External context reference (raw)               |
| `{{$context}}`      | External context reference (escaped)           |
| `{expr}`            | Formula expression (raw) - arithmetic, logic   |
| `{{expr}}`          | Formula expression (escaped)                   |
| `\\{{escaped}}`     | Escaped braces - renders literal `{{escaped}}` |
| `\\{escaped}`       | Escaped brace - renders literal `{escaped}`    |
| `{{{...}}}`         | Three or more braces - treated as literal text |
| `{{:key}}`          | Wrapped reference (wrapped with label chars)   |

**Single-value templates**: When a template contains exactly one expression/reference and nothing else (e.g. `'{a + b}'`), the `resolve()` method returns the raw value (number, object, etc.) instead of converting to string. This is how `Joi.x('{a + b}')` can return a number for use in `.valid()`.

**Multi-part templates**: When a template contains text mixed with references, all parts are stringified and concatenated.

#### Template constants

Templates support the following built-in constants in expressions:

| Constant  | Value                |
| --------- | -------------------- |
| `true`    | `true`               |
| `false`   | `false`              |
| `null`    | `null`               |
| `second`  | `1000`               |
| `minute`  | `60000`              |
| `hour`    | `3600000`            |
| `day`     | `86400000`           |

    // Use time constants in expressions
    Joi.date().max(Joi.x('{now + 7 * day}'));

#### Template built-in functions

| Function                   | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `if(condition, then, else)` | Returns `then` if condition is truthy, `else` otherwise |
| `length(value)`            | Returns length of string or array, or key count of object. Returns `null` for non-objects/non-strings/numbers. |
| `msg(code)`                | Looks up another error message by code and renders it. Searches custom messages first, then defaults. Returns `''` if not found. |
| `number(value)`            | Casts to number. Handles: numbers (passthrough), strings (`parseFloat`), booleans (`true`=1, `false`=0), Dates (`.getTime()`). Returns `null` for other types. |

    // Conditional in expression
    Joi.x('{if(a > 10, "big", "small")}')

    // Length in rule argument
    Joi.object({
        a: Joi.array().length(Joi.x('{length(b)}')),
        b: Joi.object()
    });

    // Number casting
    Joi.valid(Joi.x('{number(1) + number(true) + number("1")}'))  // resolves to 3

    // Cross-reference messages
    Joi.string().messages({
        'string.min': '{msg("custom.hint")} - too short',
        'custom.hint': 'Please check requirements'
    });

#### Custom template functions

Pass custom functions via the `functions` option on `Joi.expression()` / `Joi.x()`. Custom functions can override built-in ones.

    // Custom function
    Joi.object().rename(/.*/, Joi.x('{ uppercase(#0) }', {
        functions: {
            uppercase(value) {
                return typeof value === 'string' ? value.toUpperCase() : value;
            }
        }
    }));
    // { a: 1, b: 2 } -> { A: 1, B: 2 }

    // Override built-in function
    Joi.object({
        a: Joi.array().length(Joi.x('{length(b)}', {
            functions: {
                length(value) {
                    return value.length - 1;
                }
            }
        })),
        b: Joi.string()
    });

#### Stringification rules

When template values are rendered to strings:

| Type      | Rendering                                              |
| --------- | ------------------------------------------------------ |
| `null`    | `'null'`                                               |
| `string`  | The string value (optionally wrapped with string wrap chars) |
| `number`  | `.toString()`                                          |
| `boolean` | `JSON.stringify()` (`'true'` / `'false'`)              |
| `function`| `.toString()`                                          |
| `symbol`  | `.toString()`                                          |
| `Date`    | Formatted per `prefs.dateFormat` setting (`'iso'`, `'date'`, `'string'`, `'time'`, `'utc'`) |
| `Map`     | Entries rendered as `'key -> value'` pairs, comma-separated |
| `Array`   | Items comma-separated, wrapped with array wrap chars   |
| `object`  | `.toString()`                                          |

#### Custom messages with templates

    Joi.string().min(3).messages({
        'string.min': '{{#label}} needs at least {{#limit}} chars (got {{#value}})'
    });

    // #label - the field label (automatically wrapped with label wrap chars)
    // #limit - the rule argument
    // #value - the actual value being validated

HTML escaping: Double-brace `{{}}` references are HTML-escaped by default. Use single-brace `{}` for raw output. HTML escaping can be disabled globally via `errors.escapeHtml: false` in validation options.


### `Joi.isRef(value)`


Returns `true` if the value is a joi reference (has the internal ref symbol).

    Joi.isRef(Joi.ref('a.b'));  // true
    Joi.isRef('a.b');           // false
    Joi.isRef(null);            // false


### `Joi.isExpression(value)`


Returns `true` if the value is a joi template expression (has the internal template symbol).

    Joi.isExpression(Joi.x('{a + b}'));  // true
    Joi.isExpression('test');            // false
    Joi.isExpression(null);              // false

## Built-in Types


All types inherit from `any()`. Create via `Joi.<type>()`.

| Constructor              | Aliases          | Validates                                     |
| ------------------------ | ---------------- | --------------------------------------------- |
| `Joi.any()`              |                  | Any value (base type)                         |
| `Joi.string()`           |                  | Strings                                       |
| `Joi.number()`           |                  | Numbers                                       |
| `Joi.boolean()`          | `Joi.bool()`     | Booleans                                      |
| `Joi.date()`             |                  | Dates (JS Date, ISO strings, timestamps)      |
| `Joi.object()`           |                  | Objects with key schemas                      |
| `Joi.array()`            |                  | Arrays with item schemas                      |
| `Joi.alternatives()`     | `Joi.alt()`      | One of multiple schemas                       |
| `Joi.binary()`           |                  | Buffer data                                   |
| `Joi.function()`         | `Joi.func()`     | Functions (extends object type)               |
| `Joi.link()`             |                  | Links to other schemas by `$id`               |
| `Joi.symbol()`           |                  | Symbols                                       |


### string


    Joi.string()
        .min(1).max(255)            // Length constraints
        .min(1, 'utf8')             // Length in bytes (with encoding)
        .length(10, 'utf8')         // Exact byte length
        .pattern(/^[a-z]+$/)        // Regex (alias: .regex())
        .pattern(/^[a-z]+$/, 'name') // Named pattern (string shorthand for { name })
        .pattern(/^[a-z]+$/, { name: 'alpha', invert: false })
        .email()                    // Email validation (@hapi/address)
        .email({
            multiple: true,         // Allow multiple emails
            separator: ',',         // Custom separator (default ',')
            tlds: { allow: ['com'] }, // Restrict TLDs
            ignoreLength: true,     // Ignore RFC length limit
            allowUnicode: true,     // Allow unicode characters
            allowFullyQualified: true, // Allow trailing dot
            minDomainSegments: 2,   // Min domain segments
            maxDomainSegments: 4    // Max domain segments
        })
        .uri({
            scheme: ['http', 'https'],
            allowRelative: true,    // Allow relative URIs
            relativeOnly: true,     // Only allow relative URIs
            allowQuerySquareBrackets: true,
            encodeUri: true,        // Auto-encode URI on convert
            domain: {               // Domain-specific options
                allowUnicode: true,
                tlds: { allow: ['com'] }
            }
        })
        .ip({ version: ['ipv4', 'ipv6'], cidr: 'optional' })
        .domain({
            allowFullyQualified: true,
            allowUnicode: true,
            allowUnderscore: true,
            minDomainSegments: 2,
            maxDomainSegments: 4,
            tlds: { allow: true }   // true = built-in list, false = any
        })
        .guid()                     // UUID (alias: .uuid())
        .guid({
            version: ['uuidv4'],    // uuidv1-uuidv8
            separator: '-',         // '-', ':', true (require), false (forbid)
            wrapper: '{'            // '{', '[', '(', true (require any), false (forbid)
        })
        .hex()                      // Hex string
        .hex({
            byteAligned: true,      // Must be even length (auto-pads 0 on coerce)
            prefix: true            // Require 0x prefix; 'optional' = allow but not require
        })
        .base64()                   // Base64 string
        .base64({
            paddingRequired: true,  // Default true; require = padding
            urlSafe: false          // Default false; URL-safe alphabet
        })
        .creditCard()               // Luhn credit card validation
        .hostname()                 // Valid hostname (domain or IP)
        .alphanum()
        .token()                    // a-zA-Z0-9_
        .trim()                     // Trim whitespace (+ coerce)
        .lowercase()                // Force lowercase (+ coerce)
        .uppercase()                // Force uppercase (+ coerce)
        .case('lower')              // Same as .lowercase()/.uppercase()
        .replace(pattern, replacement) // String or RegExp pattern
        .truncate()                 // Truncate to max length on coerce
        .insensitive()              // Case-insensitive .valid()
        .isoDate()                  // ISO 8601 date string (coerces to canonical form)
        .isoDuration()              // ISO 8601 duration
        .dataUri()                  // Data URI
        .dataUri({ paddingRequired: true }) // Base64 padding in data URI
        .normalize('NFC')           // Unicode normalization (NFC, NFD, NFKC, NFKD)

**Gotchas:**

- `Joi.string()` rejects empty strings `''` by default. Use `.allow('')` or `.min(0)` to accept them.
- `.isoDate()` coerces the string to a canonical ISO 8601 form (via `Date.toISOString()`), so the output may differ from input.
- `.pattern()` does not allow global (`g`) or sticky (`y`) regex flags.
- `.replace()` is a coercion applied during conversion, not a validation rule.
- `.truncate()` only takes effect when used with `.max()`.
- `.lowercase()`/`.uppercase()` both validate and coerce. Without `convert: true`, they reject mismatched case.


### number


    Joi.number()
        .min(0).max(100)
        .greater(5).less(50)
        .integer()
        .positive().negative()
        .precision(2)               // Max decimal places (coerces by rounding)
        .multiple(5)                // Must be multiple of
        .port()                     // 0-65535 integer
        .sign('positive')           // 'positive' or 'negative'
        .unsafe()                   // Allow values outside safe integer range
        .cast('string')             // Cast result to string

**Gotchas:**

- By default, `Joi.number()` coerces strings to numbers when `convert: true` (default). Infinity and -Infinity are rejected.
- `.precision(n)` with `convert: true` rounds the value to `n` decimal places. Without conversion, it validates only.
- `-0` is normalized to `0`.
- Unsafe numbers (outside `Number.MIN_SAFE_INTEGER` to `Number.MAX_SAFE_INTEGER`) are rejected unless `.unsafe()` is used. This applies both to input numbers and coerced string values.
- `.multiple()` supports decimal bases (e.g., `.multiple(0.01)`) and can be called multiple times.


### boolean


    Joi.boolean()
        .truthy('yes', 'on', '1')   // Additional truthy values
        .falsy('no', 'off', '0')    // Additional falsy values
        .sensitive()                 // Case-sensitive truthy/falsy matching
        .cast('number')             // Cast to 1/0
        .cast('string')             // Cast to 'true'/'false'

**Gotchas:**

- By default, coerces the strings `'true'`/`'false'` (case-insensitive) to booleans. Whitespace is trimmed.
- Numbers `0`/`1` are NOT coerced by default. You must explicitly add them via `.truthy(1).falsy(0)`.
- Empty strings are NOT coerced to `false`.
- `.truthy()` and `.falsy()` are additive -- calling them multiple times adds values, it does not replace.
- `.sensitive()` affects matching of both the built-in `'true'`/`'false'` strings and custom truthy/falsy values.


### date


    Joi.date()
        .min('1-1-2020').max('now')
        .greater('now').less('2030-01-01')
        .iso()                      // Require ISO 8601 format
        .timestamp('javascript')    // 'javascript' (ms) or 'unix' (s)
        .format('iso')              // General: 'iso', 'javascript', or 'unix'
        .cast('number')             // Cast to timestamp (ms)
        .cast('string')             // Cast to ISO string

**Gotchas:**

- `'now'` is evaluated at validation time.
- `.iso()` is shorthand for `.format('iso')`, and `.timestamp(type)` is shorthand for `.format(type)`.
- Without a format, `Joi.date()` coerces both strings and numbers to Date objects using `new Date(value)`.
- With `.timestamp('unix')`, the input is multiplied by 1000 to get milliseconds.
- `.min()`, `.max()`, `.greater()`, `.less()` accept Date objects, ISO strings, timestamps, or `'now'`.


### object


    Joi.object({
        a: Joi.string(),
        b: Joi.number()
    })
        .keys({ c: Joi.boolean() }) // Add/override keys
        .append({ d: Joi.any() })   // Add keys (no override); no-op if empty/null
        .unknown(true)              // Allow unknown keys
        .min(1).max(10)             // Key count constraints
        .length(5)
        .pattern(/^s_/, Joi.string())  // Validate keys by pattern
        .pattern(/^s_/, Joi.string(), { fallthrough: true }) // Continue checking other patterns
        .pattern(/^s_/, Joi.string(), { matches: Joi.array().min(2) }) // Validate matched key list
        .pattern(Joi.string().min(2), Joi.number()) // Schema-based key pattern
        .and('a', 'b')             // All or none must exist
        .nand('a', 'b')            // Cannot all exist together
        .or('a', 'b')              // At least one must exist
        .xor('a', 'b')            // Exactly one must exist
        .oxor('a', 'b')           // Zero or one must exist
        .with('a', 'b')           // If a exists, b must too
        .with('a', ['b', 'c'])    // If a exists, b and c must too
        .without('a', 'b')        // If a exists, b must not
        .rename('old', 'new')      // Rename keys
        .rename('old', 'new', {
            alias: true,           // Keep original key (default false)
            multiple: true,        // Allow multiple renames to same target (default false)
            override: true,        // Override existing target key (default false)
            ignoreUndefined: true  // Skip if source is undefined
        })
        .rename(/^prefix_(.+)$/, Joi.expression('{#1}')) // Regex rename with template
        .assert('.b', Joi.ref('a'))// Assert relationship
        .assert('.b', Joi.valid(1), 'custom message') // With message
        .instance(RegExp)          // Must be instance of
        .instance(RegExp, 'RegExp') // With custom name for errors
        .schema()                  // Must be a joi schema
        .schema('string')          // Must be a joi schema of specific type
        .ref()                     // Must be a Joi.ref() object
        .regex()                   // Must be a RegExp object

**Gotchas:**

- `Joi.object()` strips unknown keys by default when `stripUnknown: true` is set in options. Keys not listed in the schema are unknown.
- `.keys()` called with no arguments allows any keys; called with `{}` allows no unknown keys.
- Dependency methods (`.and()`, `.or()`, etc.) accept an options object as the last argument with `{ separator, isPresent }` to customize path separator and presence check.
- `.with()` and `.without()` take a key and peers (string or array), while `.and()`, `.or()`, `.xor()`, `.nand()`, `.oxor()` take variadic peer arguments.
- `.pattern()` can use a regex or a joi schema as the key matcher.
- `Joi.function()` extends `Joi.object()`, so all object methods (`.keys()`, `.unknown()`, etc.) work on functions.
- `.assert()` can be called multiple times (multi rule).
- Object can be cast to a `Map` via `.cast('map')`.


### array


    Joi.array()
        .items(Joi.string(), Joi.number())    // Allowed item types
        .ordered(Joi.string(), Joi.number())  // Positional types
        .min(1).max(10)
        .length(5)
        .unique()                              // No duplicates
        .unique('id')                          // Unique by property
        .unique('a.b', { separator: '.' })     // Nested property with separator
        .unique((a, b) => a.id === b.id)       // Custom comparator
        .unique('id', { ignoreUndefined: true }) // Ignore undefined values
        .has(Joi.string().min(5))              // Must contain match
        .sparse(true)                          // Allow undefined items
        .single()                              // Wrap non-array in array
        .sort({ order: 'ascending', by: 'name' })
        .cast('set')                           // Cast result to Set

**Gotchas:**

- `.items()` with required schemas (e.g., `Joi.string().required()`) means the array must contain at least one item matching each required schema.
- `.items()` with forbidden schemas (e.g., `Joi.string().forbidden()`) excludes matching items.
- `.ordered()` validates items by position. If the array is longer than the ordered schemas and no `.items()` are defined, extra items fail with `array.orderedLength`.
- `.single()` cannot be combined with array-type items.
- `.sort()` coerces the array order when `convert: true`; otherwise validates order only.
- `.unique()` can be called multiple times.
- `.has()` can be called multiple times.


### alternatives


    // try() - match first passing schema
    Joi.alternatives().try(Joi.string(), Joi.number())

    // Shorthand constructor
    Joi.alternatives(Joi.string(), Joi.number())

    // conditional
    Joi.alternatives().conditional('type', {
        is: 'a',
        then: Joi.string(),
        otherwise: Joi.number()
    })

    // switch
    Joi.alternatives().conditional('type', {
        switch: [
            { is: 'a', then: Joi.string() },
            { is: 'b', then: Joi.number() }
        ],
        otherwise: Joi.any()
    })

    // match mode
    Joi.alternatives()
        .try(Joi.string(), Joi.number())
        .match('all')    // 'any' (default), 'all', 'one'

**Gotchas:**

- `match: 'one'` requires exactly one schema to match (fails if zero or more than one match).
- `match: 'all'` requires all schemas to match. For object schemas, results are merged.
- `match` mode cannot be combined with `.conditional()` rules.
- `.conditional()` ends the chain once a condition with both `then` and `otherwise` is added (unreachable conditions after that throw).


### binary


    Joi.binary()
        .encoding('base64')     // Set encoding for string coercion
        .min(1).max(1024)       // Byte length
        .length(16)
        .cast('string')         // Cast buffer to string

**Gotchas:**

- Coerces strings to Buffers using the specified encoding (or default).
- Also coerces objects with `{ type: 'Buffer' }` shape (JSON-serialized Buffers).


### function


    Joi.function()
        .arity(2)               // Exact argument count
        .minArity(1)
        .maxArity(3)
        .class()                // Must be a class (checks for 'class' keyword)

**Gotchas:**

- `Joi.function()` extends `Joi.object()`, so all object methods work: `.keys()`, `.unknown()`, `.pattern()`, `.rename()`, etc. This allows validating functions that also have properties.
- `.class()` checks by inspecting the function's string representation for the `class` keyword.


### link


    // Reference another schema by $id
    Joi.object({
        a: Joi.string(),
        b: Joi.link('#root')
    }).id('root')

    // Relative links (ancestor references)
    Joi.link('...')              // Grandparent schema
    Joi.link('#id')              // By schema $id

    // Relative flag for dynamic resolution
    Joi.link('...').relative()   // Re-resolve on each validation (not cached)

**Gotchas:**

- Links are resolved and cached on first validation. Use `.relative()` if the linked schema may change between validations.
- Links cannot reference themselves directly (ancestor must be > 0 or 'root').
- A link cannot point to another link.
- `.concat()` on a link merges with the resolved schema.


### symbol


    Joi.symbol()
        .map({
            key1: Symbol('one'),
            key2: Symbol('two')
        })

**Gotchas:**

- `.map()` also accepts an iterable of `[key, symbol]` entries (e.g., `Map` or array of pairs).
- `.map()` automatically adds the symbol values to `.valid()`, so only mapped symbols are allowed.
- Coercion converts string/number keys to their mapped symbol values.

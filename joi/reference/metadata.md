## Schema Metadata & Introspection


Use `.describe()` to extract a full schema description as a plain object. This is the foundation for generating OpenAPI specs, documentation, form builders, or any schema-driven tooling.


### `.describe()` output shape


Every description has a `type` and optional metadata, flags, rules, and terms:

    {
        type: 'string',                  // Schema type
        flags: {                          // Schema flags (omitted if empty)
            description: 'User email',
            label: 'Email',
            presence: 'required',
            default: 'user@example.com',
            id: 'emailField',
            only: true,                   // When .valid() is used
            result: 'strip',              // When .strip() is used
            cast: 'number',               // When .cast() is used
            empty: { type: 'string', rules: [...] },  // Nested schema description
            unit: 'ms',
            artifact: 'some-value',       // When .artifact() is used
            error: <Error>,               // When .error() is used (Error objects pass through)
            unknown: true                 // Object-only: .unknown() flag
        },
        rules: [                          // Validation rules (omitted if empty)
            { name: 'min', args: { limit: 5 } },
            { name: 'max', args: { limit: 255 } },
            { name: 'email', args: { options: { tlds: { allow: true } } } },
            { name: 'pattern', args: { regex: '/^[a-z]/' } },
            { name: 'custom', args: { method: <function>, description: 'check' } },
            { name: 'warning', args: { code: 'warn.code' }, warn: true }
        ],
        allow: [null, ''],               // Values from .allow()
        invalid: ['admin@test.com'],      // Values from .invalid()
        preferences: { convert: false },  // From .prefs()
        metas: [{ openapi: { format: 'email' } }],
        notes: ['Used for login'],
        tags: ['auth', 'user'],
        examples: [{ value: 'user@company.com' }]
    }

Flags starting with `_` are excluded from describe output. Rules with `manifest: false` in their definition are also excluded.

Rule modifiers (`keep`, `message`, `warn`) appear as extra keys on the rule object when set:

    { name: 'min', args: { limit: 5 }, keep: true, warn: true, message: 'Too short' }


### Object description


Object schemas describe keys as a mapped object (via `manifest.mapped: { from: 'schema', to: 'key' }`):

    Joi.object({
        name: Joi.string().min(1).required().description('Full name'),
        age: Joi.number().integer().min(0).description('Age in years'),
        role: Joi.string().valid('admin', 'user').default('user')
    }).describe()

    // {
    //     type: 'object',
    //     keys: {
    //         name: {
    //             type: 'string',
    //             flags: { presence: 'required', description: 'Full name' },
    //             rules: [{ name: 'min', args: { limit: 1 } }]
    //         },
    //         age: {
    //             type: 'number',
    //             flags: { description: 'Age in years' },
    //             rules: [
    //                 { name: 'integer' },
    //                 { name: 'min', args: { limit: 0 } }
    //             ]
    //         },
    //         role: {
    //             type: 'string',
    //             flags: { default: 'user', only: true },
    //             allow: ['admin', 'user']
    //         }
    //     }
    // }

Object-specific terms:

| Term             | From                    | Description                            |
| ---------------- | ----------------------- | -------------------------------------- |
| `keys`           | `.keys()` / constructor | Object mapping key->description (mapped term) |
| `dependencies`   | `.and()`, `.or()`, etc. | Peer dependency rules (array)          |
| `patterns`       | `.pattern()`            | Key pattern validations (array)        |
| `renames`        | `.rename()`             | Key rename rules (array)               |

#### Dependencies describe format

    Joi.object().and('a', 'b', { separator: '.' }).describe()
    // dependencies: [{ rel: 'and', peers: ['a', 'b'] }]

    Joi.object().with('a', 'b').describe()
    // dependencies: [{ rel: 'with', key: 'a', peers: ['b'] }]

The dependency description object:

    {
        rel: 'and' | 'nand' | 'or' | 'oxor' | 'xor' | 'with' | 'without',
        peers: ['field1', 'field2'],     // Array of peer path strings
        key: 'fieldName',               // Only for 'with' and 'without'
        options: {                       // Only when non-default
            separator: '.',             // When custom separator used
            isPresent: <function>       // When custom presence check used
        }
    }

#### Patterns describe format

    Joi.object().pattern(/^s_/, Joi.string()).describe()
    // patterns: [{ regex: '/^s_/', rule: { type: 'string' } }]

    Joi.object().pattern(Joi.string().min(2), Joi.number()).describe()
    // patterns: [{ schema: { type: 'string', ... }, rule: { type: 'number' } }]

Pattern objects have `regex` or `schema` (the key matcher), `rule` (the value schema description), and optionally `fallthrough` and `matches`.

#### Renames describe format

    Joi.object().rename('old', 'new', { alias: true }).describe()
    // renames: [{ from: 'old', to: 'new', options: { alias: true, ignoreUndefined: false, override: false, multiple: false } }]

Rename objects have `from` (string or regex description), `to` (string or template description), and `options` with keys: `alias`, `ignoreUndefined`, `override`, `multiple`.


### Array description


    Joi.array().items(Joi.string(), Joi.number().required()).min(1).describe()

    // {
    //     type: 'array',
    //     rules: [{ name: 'min', args: { limit: 1 } }],
    //     items: [
    //         { type: 'string' },
    //         { type: 'number', flags: { presence: 'required' } }
    //     ]
    // }

Array-specific terms:

| Term       | From          | Description                       |
| ---------- | ------------- | --------------------------------- |
| `items`    | `.items()`    | Allowed item schemas              |
| `ordered`  | `.ordered()`  | Positional item schemas           |
| `_inclusions` | (internal) | Not in describe (starts with `_`) |
| `_exclusions` | (internal) | Not in describe (starts with `_`) |
| `_requireds` | (internal)  | Not in describe (starts with `_`) |

    Joi.array().ordered(Joi.number(), Joi.boolean()).describe()
    // {
    //     type: 'array',
    //     ordered: [
    //         { type: 'number' },
    //         { type: 'boolean' }
    //     ]
    // }

The `has` rule is included in `rules`:

    Joi.array().has(Joi.string()).describe()
    // { type: 'array', rules: [{ name: 'has', args: { schema: { type: 'string' } } }] }


### Alternatives description


    Joi.alternatives().conditional('type', {
        is: 'a',
        then: Joi.string(),
        otherwise: Joi.number()
    }).describe()

    // {
    //     type: 'alternatives',
    //     matches: [{
    //         ref: { path: ['type'] },
    //         is: { type: 'any', flags: { only: true, presence: 'required' }, allow: [{ override: true }, 'a'] },
    //         then: { type: 'string' },
    //         otherwise: { type: 'number' }
    //     }]
    // }

Note: The `is` clause is compiled with `Joi.override` in the allow list and `presence: 'required'` by default.

#### When (on typed schemas) describe format

Whens on non-alternative schemas appear in the `whens` term:

    Joi.number().when('$x', {
        is: true,
        then: Joi.required(),
        otherwise: Joi.forbidden()
    }).describe()

    // whens: [{
    //     ref: { path: ['x'], ancestor: 'global' },
    //     is: { type: 'any', flags: { only: true, presence: 'required' }, allow: [{ override: true }, true] },
    //     then: { type: 'any', flags: { presence: 'required' } },
    //     otherwise: { type: 'any', flags: { presence: 'forbidden' } }
    // }]

Switch form:

    Joi.number().when('a', {
        switch: [{ is: 0, then: Joi.valid(1) }],
        otherwise: Joi.valid(4)
    }).describe()

    // whens: [{
    //     ref: { path: ['a'] },
    //     switch: [{ is: ..., then: ... }],
    //     otherwise: ...
    // }]


### References in descriptions


References are serialized as objects:

    Joi.number().max(Joi.ref('limit')).describe()

    // {
    //     type: 'number',
    //     rules: [{
    //         name: 'max',
    //         args: { limit: { ref: { path: ['limit'] } } }
    //     }]
    // }

Reference description shapes:

    { ref: { path: ['sibling'] } }                          // Sibling
    { ref: { path: ['field'], ancestor: 2 } }               // Parent (..field)
    { ref: { path: ['field'], ancestor: 'root' } }          // Root (/field)
    { ref: { path: ['x'], ancestor: 'global' } }            // Global ($x)
    { ref: { path: ['key'], in: true } }                    // Joi.in()
    { ref: { path: ['key'], adjust: <function> } }          // With adjust
    { ref: { path: ['key'], map: [[1, 'one'], [2, 'two']] } }

When a ref is in a position with `assign: 'ref'`, only the inner `ref` object is used (unwrapped).


### Special values in descriptions


    { override: true }             // Joi.override
    { special: 'deep' }            // Joi.any().default(Joi.ref('$x')) deep default symbol
    { template: '{{#label}}...' }  // Template strings
    { regex: '/^abc/i' }           // RegExp patterns (when not in 'regex' assign position)
    { value: { ... } }             // Wrapped objects/arrays (via clone)
    { buffer: 'binarydata' }       // Binary buffers (toString('binary'))
    { function: <fn> }             // Literal function defaults (from options.literal)

Date values are serialized as ISO strings. Error objects pass through as-is. Empty `options` objects on rules are omitted.


### Adding metadata for documentation


Use these methods to annotate schemas for tooling:

    const schema = Joi.object({
        email: Joi.string()
            .email()
            .required()
            .label('Email Address')             // Error message label
            .description('Primary email')       // Descriptive text
            .note('Must be verified')           // Documentation notes
            .tag('auth', 'pii')                 // Categorization
            .meta({ openapi: { format: 'email' } })  // Arbitrary metadata
            .example('user@example.com')        // Example values
            .unit('email'),                     // Unit of measurement

        age: Joi.number()
            .integer()
            .min(0)
            .max(150)
            .description('Age in years')
            .unit('years')
            .meta({ openapi: { example: 25 } })
    })
        .id('UserInput')                        // Schema identifier
        .description('User registration input')
        .meta({ openapi: { title: 'UserInput' } });


### Extracting nested schemas


#### By path

    const schema = Joi.object({
        user: Joi.object({
            name: Joi.string().id('userName')
        })
    });

    schema.extract('user.name');      // Returns the string schema
    schema.extract(['user', 'name']); // Array path form

#### By id

Extract checks `_byId` map first, then `_byKey` map at each level. So `.id()` takes priority over key names. The lookup is per-level (not a global tree search):

    const schema = Joi.object({
        a: Joi.object({
            b: Joi.string().id('myField')
        })
    });

    schema.extract('a.myField');     // Works: 'a' by key, then 'myField' by id
    schema.extract('a.b');           // Also works: 'a' by key, then 'b' by key

Throws if path not found.


### Walking a description tree


    function walkDescription(desc, visitor, path = []) {

        visitor(desc, path);

        // Object keys
        if (desc.keys) {
            for (const [key, child] of Object.entries(desc.keys)) {
                walkDescription(child, visitor, [...path, key]);
            }
        }

        // Array items
        if (desc.items) {
            for (const item of desc.items) {
                walkDescription(item, visitor, [...path, 'items']);
            }
        }

        // Alternatives
        if (desc.matches) {
            for (const match of desc.matches) {
                if (match.schema) walkDescription(match.schema, visitor, [...path, 'match']);
                if (match.then) walkDescription(match.then, visitor, [...path, 'then']);
                if (match.otherwise) walkDescription(match.otherwise, visitor, [...path, 'otherwise']);
                if (match.switch) {
                    for (const s of match.switch) {
                        if (s.then) walkDescription(s.then, visitor, [...path, 'then']);
                        if (s.otherwise) walkDescription(s.otherwise, visitor, [...path, 'otherwise']);
                    }
                }
            }
        }

        // Ordered items
        if (desc.ordered) {
            for (const item of desc.ordered) {
                walkDescription(item, visitor, [...path, 'ordered']);
            }
        }

        // Whens (on non-alternatives)
        if (desc.whens) {
            for (const when of desc.whens) {
                if (when.is) walkDescription(when.is, visitor, [...path, 'when.is']);
                if (when.then) walkDescription(when.then, visitor, [...path, 'when.then']);
                if (when.otherwise) walkDescription(when.otherwise, visitor, [...path, 'when.otherwise']);
                if (when.switch) {
                    for (const s of when.switch) {
                        if (s.is) walkDescription(s.is, visitor, [...path, 'switch.is']);
                        if (s.then) walkDescription(s.then, visitor, [...path, 'switch.then']);
                        if (s.otherwise) walkDescription(s.otherwise, visitor, [...path, 'switch.otherwise']);
                    }
                }
            }
        }
    }


### Joi to OpenAPI mapping


Map describe() output to OpenAPI schema properties:

| Joi describe                       | OpenAPI property               |
| ---------------------------------- | ------------------------------ |
| `desc.type`                        | `schema.type`                  |
| `desc.flags.description`           | `schema.description`           |
| `desc.flags.label`                 | `schema.title`                 |
| `desc.flags.default`               | `schema.default`               |
| `desc.flags.presence === 'required'` | parent `required[]` array    |
| `desc.flags.only` + `desc.allow`   | `schema.enum`                  |
| `desc.allow` (includes `null`)     | `schema.nullable`              |
| `desc.rules` `min`                 | `schema.minimum` / `schema.minLength` / `schema.minItems` |
| `desc.rules` `max`                 | `schema.maximum` / `schema.maxLength` / `schema.maxItems` |
| `desc.rules` `integer`             | `schema.type = 'integer'`      |
| `desc.rules` `pattern`             | `schema.pattern`               |
| `desc.rules` `email`               | `schema.format = 'email'`      |
| `desc.rules` `uri`                 | `schema.format = 'uri'`        |
| `desc.rules` `isoDate`             | `schema.format = 'date-time'`  |
| `desc.examples`                    | `schema.examples`              |
| `desc.metas`                       | Merge custom OpenAPI overrides |
| `desc.notes`                       | `schema.description` (append)  |
| `desc.keys`                        | `schema.properties`            |
| `desc.items`                       | `schema.items`                 |
| `desc.matches`                     | `schema.oneOf` / `schema.anyOf` |

Example converter skeleton:

    function joiToOpenAPI(desc) {

        const typeMap = {
            string: 'string',
            number: 'number',
            boolean: 'boolean',
            date: 'string',
            binary: 'string',
            array: 'array',
            object: 'object',
            alternatives: null     // Uses oneOf/anyOf
        };

        const result = {};

        if (desc.type === 'alternatives') {
            result.oneOf = (desc.matches || [])
                .map((m) => m.schema || m.then)
                .filter(Boolean)
                .map(joiToOpenAPI);
            return result;
        }

        result.type = typeMap[desc.type] || desc.type;

        // Flags
        if (desc.flags?.description) result.description = desc.flags.description;
        if (desc.flags?.label) result.title = desc.flags.label;
        if (desc.flags?.default !== undefined) result.default = desc.flags.default;

        // Enums
        if (desc.flags?.only && desc.allow) {
            result.enum = desc.allow.filter((v) => v !== null);
            if (desc.allow.includes(null)) result.nullable = true;
        }

        // Rules
        for (const rule of desc.rules || []) {

            switch (rule.name) {
                case 'min':
                    result[desc.type === 'string' ? 'minLength' :
                           desc.type === 'array' ? 'minItems' : 'minimum'] = rule.args.limit;
                    break;
                case 'max':
                    result[desc.type === 'string' ? 'maxLength' :
                           desc.type === 'array' ? 'maxItems' : 'maximum'] = rule.args.limit;
                    break;
                case 'integer':
                    result.type = 'integer';
                    break;
                case 'pattern':
                    result.pattern = rule.args.regex;
                    break;
                case 'email':
                    result.format = 'email';
                    break;
                case 'uri':
                    result.format = 'uri';
                    break;
                case 'isoDate':
                    result.format = 'date-time';
                    break;
            }
        }

        // Date format
        if (desc.type === 'date') result.format = result.format || 'date-time';
        if (desc.type === 'binary') result.format = 'byte';

        // Object keys
        if (desc.keys) {
            result.properties = {};
            result.required = [];
            for (const [key, child] of Object.entries(desc.keys)) {
                result.properties[key] = joiToOpenAPI(child);
                if (child.flags?.presence === 'required') {
                    result.required.push(key);
                }
            }

            if (!result.required.length) delete result.required;
        }

        // Array items
        if (desc.items) {
            result.items = desc.items.length === 1
                ? joiToOpenAPI(desc.items[0])
                : { oneOf: desc.items.map(joiToOpenAPI) };
        }

        // Custom meta overrides (last wins)
        for (const m of desc.metas || []) {
            if (m.openapi) Object.assign(result, m.openapi);
        }

        // Examples
        if (desc.examples?.length) {
            result.examples = desc.examples.map((e) => e.value ?? e);
        }

        return result;
    }


### Reconstructing schemas from descriptions


#### `Joi.build(description)`

Rebuild a schema from a describe() output:

    const desc = schema.describe();
    const rebuilt = Joi.build(desc);

    // Round-trip: describe → build → describe should match
    const desc2 = rebuilt.describe();
    // desc and desc2 are deeply equal

The build process:
1. Creates a bare schema of `desc.type` (via `_bare()` which resets all state)
2. Applies flags by calling the corresponding setter method (e.g., `description` -> `.description()`)
3. Applies preferences via `.preferences()`
4. Applies `allow` and `invalid` values
5. Applies rules by calling the rule method with rebuilt args
6. Applies rule modifiers (keep, message, warn) via `.rule()`
7. Processes terms based on their manifest config: `'schema'` (parse as schemas), `'values'` (build as values), `'single'` (single value), mapped objects, or default build
8. Processes `whens` separately
9. Calls the type's `manifest.build()` method with all terms

Special value reconstruction:
- `{ buffer: '...' }` -> `Buffer.from(data, 'binary')`
- `{ function: fn }` -> literal function wrapper
- `{ override: true }` -> `Joi.override` symbol
- `{ ref: {...} }` -> `Ref.build()`
- `{ regex: '/.../flags' }` -> `new RegExp()`
- `{ special: 'deep' }` -> deep default symbol
- `{ value: {...} }` -> cloned value
- `{ template: '...' }` -> `Template.build()`
- `{ type: '...' }` -> recursive `parse()` (nested schema)

**Gotcha:** Functions (custom validators, adjust callbacks) cannot survive JSON serialization. Only use `build()` with descriptions that don't contain function references, or preserve them through a non-JSON transport. Note that function values do pass through describe/build if the description object is kept in memory (not serialized).


### Introspection methods summary


| Method                        | Returns                                    |
| ----------------------------- | ------------------------------------------ |
| `schema.describe()`           | Full schema description object             |
| `schema.extract(path)`        | Nested schema at path (by id or key)       |
| `schema.isAsync()`            | `true` if schema uses async validation     |
| `Joi.isSchema(value)`         | `true` if value is a joi schema            |
| `Joi.isRef(value)`            | `true` if value is a joi reference         |
| `Joi.isExpression(value)`     | `true` if value is a joi template          |
| `Joi.isError(err)`            | `true` if err is a ValidationError         |
| `Joi.build(description)`      | Schema reconstructed from description      |
| `Joi.types()`                 | Object of all type constructors (includes aliases: alt, bool, func) |

## Custom Extensions


### `Joi.extend(...extensions)`


Creates a new joi instance with custom types. Does not modify the original.

    const custom = Joi.extend((joi) => ({
        type: 'myString',
        base: joi.string(),

        messages: {
            'myString.startsWithUpper': '{{#label}} must start with an uppercase letter'
        },

        validate(value, helpers) {

            if (value[0] !== value[0].toUpperCase()) {
                return { value, errors: helpers.error('myString.startsWithUpper') };
            }
        }
    }));

    const schema = custom.myString().min(3);


### Extension structure


    {
        type: 'typeName',           // Required. Type name for Joi.typeName()
        base: Joi.any(),            // Optional. Base schema to extend
        args: Function,             // Optional. Custom argument parsing

        // Schema preparation (called once during schema construction)
        prepare(value, helpers) {
            return { value };       // Transform before coercion
        },

        // Type coercion (convert: true)
        coerce: {
            from: 'string',         // Only coerce from this type (optional)
            method(value, helpers) {
                return { value };
            }
        },

        // Type validation (runs after coerce)
        validate(value, helpers) {
            if (/* invalid */) {
                return { value, errors: helpers.error('typeName.code') };
            }
            return { value };
        },

        // Additional rules
        rules: {
            ruleName: {
                // How users call it
                method(arg1, arg2) {
                    return this.$_addRule({ name: 'ruleName', args: { arg1, arg2 } });
                },

                // Validation logic
                validate(value, helpers, args, options) {
                    // args = { arg1, arg2 }
                    if (/* invalid */) {
                        return helpers.error('typeName.ruleName');
                    }
                    return value;
                },

                // Argument schemas for validation
                args: [
                    {
                        name: 'arg1',
                        ref: true,          // Allow Joi.ref()
                        assert: Joi.number()
                    }
                ],

                // Allow multiple instances of this rule
                multi: false
            }
        },

        // Override parent methods
        overrides: {
            // Use this.$_parent() to call the original
            validate(value, helpers) {
                // Pre-processing
                const result = this.$_parent('validate', value, helpers);
                // Post-processing
                return result;
            }
        },

        // Custom flags
        flags: {
            myFlag: { default: false }
        },

        // Custom terms (arrays stored on schema)
        terms: {
            myTerm: { init: [] }
        },

        // Manifest support (serialization)
        manifest: {
            build(obj, desc) {
                // Reconstruct from description
            }
        },

        // Error messages
        messages: {
            'typeName.code': '{{#label}} failed typeName validation',
            'typeName.ruleName': '{{#label}} failed ruleName with {{#arg1}}'
        }
    }


### Helpers object


Available in `validate`, `coerce`, and rule `validate` functions:

| Helper                         | Description                              |
| ------------------------------ | ---------------------------------------- |
| `helpers.error(code, [local])` | Create a validation error                |
| `helpers.warn(code, [local])`  | Create a warning                         |
| `helpers.message(messages, local)` | Custom message                       |
| `helpers.schema`               | The current schema                       |
| `helpers.state`                | Current validation state (path, etc.)    |
| `helpers.prefs`                | Validation preferences                   |
| `helpers.original`             | Original unmodified value                |


### Multiple extensions

    const custom = Joi.extend(
        (joi) => ({ type: 'myString', base: joi.string(), /* ... */ }),
        (joi) => ({ type: 'myNumber', base: joi.number(), /* ... */ })
    );


### Extending existing types

    const custom = Joi.extend((joi) => ({
        type: 'string',              // Same name = override
        base: joi.string(),
        rules: {
            phoneNumber: {
                method() {
                    return this.$_addRule('phoneNumber');
                },
                validate(value, helpers) {
                    if (!/^\d{3}-\d{3}-\d{4}$/.test(value)) {
                        return helpers.error('string.phoneNumber');
                    }
                    return value;
                }
            }
        },
        messages: {
            'string.phoneNumber': '{{#label}} must be a valid phone number (xxx-xxx-xxxx)'
        }
    }));

    // Now custom.string() has .phoneNumber()


### `Joi.defaults(modifier)`


Create a customized joi where all new schemas pass through a modifier:

    const custom = Joi.defaults((schema) => {

        switch (schema.type) {
            case 'string':
                return schema.allow('');
            case 'object':
                return schema.min(1);
            default:
                return schema;
        }
    });

    custom.string().validate('');  // valid (allow '' applied by default)

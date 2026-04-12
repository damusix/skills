---
name: joi
description: "Use when building joi schemas, validating input data, defining custom types, conditional validation with .when(), cross-field references, custom error messages, or writing joi extensions. Standalone package that integrates with the hapijs ecosystem."
---

# Joi


## Quick Start

    const Joi = require('joi');

    const schema = Joi.object({
        name: Joi.string().min(1).max(100).required(),
        age: Joi.number().integer().min(0),
        email: Joi.string().email()
    });

    const { error, value } = schema.validate(input);


## Critical Rules

1. **Schemas are immutable** - Every method returns a new schema instance; never mutate
2. **Validate at boundaries** - Use `validate()` or `attempt()` at input boundaries; see [validation](reference/validation.md)
3. **Types extend base** - All types inherit from `any()`; see [types overview](reference/types.md)
4. **Refs for cross-field** - Use `Joi.ref()` for dynamic values across fields; see [references](reference/references.md)
5. **Extend for custom types** - Use `Joi.extend()` to create custom types; see [extensions](reference/extensions.md)


## Workflow

1. **Choose a type** - [types overview](reference/types.md) for all built-in types
2. **Add constraints** - Chain rules like `.min()`, `.max()`, `.pattern()`, `.valid()`
3. **Compose schemas** - Nest `Joi.object()`, `Joi.array()`, `Joi.alternatives()`
4. **Add conditionals** - Use `.when()` for dynamic schemas; see [conditionals](reference/conditionals.md)
5. **Customize errors** - Override messages via `.messages()` or `.error()`; see [errors](reference/errors.md)

## Common Patterns

### Conditional validation with `.when()`

    const schema = Joi.object({
        type: Joi.string().valid('email', 'sms').required(),
        address: Joi.when('type', {
            is: 'email',
            then: Joi.string().email().required(),
            otherwise: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).required()
        })
    });

### Cross-field references with `Joi.ref()`

    const schema = Joi.object({
        password: Joi.string().min(8).required(),
        confirmPassword: Joi.string().valid(Joi.ref('password')).required()
            .messages({ 'any.only': 'passwords must match' }),
        startDate: Joi.date().required(),
        endDate: Joi.date().greater(Joi.ref('startDate')).required()
    });


## Key Patterns

| Topic                    | Reference                                              |
| ------------------------ | ------------------------------------------------------ |
| All built-in types       | [types](reference/types.md)                            |
| Validation & options     | [validation](reference/validation.md)                  |
| References & templates   | [references](reference/references.md)                  |
| Conditional schemas      | [conditionals](reference/conditionals.md)              |
| Error handling           | [errors](reference/errors.md)                          |
| Custom extensions        | [extensions](reference/extensions.md)                  |
| Metadata & introspection | [metadata](reference/metadata.md)                      |
| Common methods (any)     | [any](reference/any.md)                                |
| Testing patterns         | [testing](reference/testing.md)                        |

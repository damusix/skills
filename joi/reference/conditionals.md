## Conditional Schemas


### `.when(condition, options)`


Adds conditional logic to any schema. The condition determines which schema applies.

#### Condition on a sibling key

    Joi.object({
        type: Joi.string().valid('email', 'phone'),
        value: Joi.when('type', {
            is: 'email',
            then: Joi.string().email(),
            otherwise: Joi.string().pattern(/^\d{10}$/)
        })
    });

#### Condition on self

    Joi.string().when('.', {
        is: Joi.string().min(10),
        then: Joi.string().max(100),
        otherwise: Joi.string().max(50)
    });

#### Switch syntax

    Joi.object({
        role: Joi.string().valid('admin', 'user', 'guest'),
        permissions: Joi.when('role', {
            switch: [
                { is: 'admin', then: Joi.array().min(1) },
                { is: 'user', then: Joi.array().max(5) }
            ],
            otherwise: Joi.array().length(0)
        })
    });

#### Reference-based condition

    Joi.object({
        min: Joi.number(),
        max: Joi.number().when('min', {
            is: Joi.exist(),
            then: Joi.number().greater(Joi.ref('min'))
        })
    });

#### Multiple peers with `is`

    Joi.when('a', {
        is: true,
        then: Joi.when('b', {
            is: true,
            then: Joi.required()
        })
    });


### `Joi.alternatives().conditional()`


Same conditional logic but at the schema level:

    const schema = Joi.alternatives().conditional('type', {
        switch: [
            { is: 'string', then: Joi.string() },
            { is: 'number', then: Joi.number() },
            { is: 'boolean', then: Joi.boolean() }
        ],
        otherwise: Joi.any()
    });


### `.alter(targets)`


Define named schema alternatives, activated by `.tailor()`:

    const schema = Joi.object({
        name: Joi.string(),
        id: Joi.number()
            .alter({
                create: (s) => s.forbidden(),
                update: (s) => s.required()
            })
    });

    const createSchema = schema.tailor('create');
    const updateSchema = schema.tailor('update');


### `.fork(paths, adjuster)`


Create a modified copy of an object schema with specific keys changed:

    const base = Joi.object({
        a: Joi.string(),
        b: Joi.number()
    });

    // Make 'a' required, 'b' forbidden
    const modified = base.fork(['a', 'b'], (field) => {
        return field.key === 'a' ? field.schema.required() : field.schema.forbidden();
    });

    // Single key shorthand
    const withRequired = base.fork('a', (field) => field.schema.required());

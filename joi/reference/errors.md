## Error Handling


### ValidationError structure


    const { error } = schema.validate(value);

    error.message;    // Human-readable summary
    error.details;    // Array of error detail objects
    error.annotate(); // Annotated version of the input

Each detail object:

    {
        message: '"name" is required',
        path: ['user', 'name'],          // Key path to the error
        type: 'any.required',            // Error code
        context: {
            label: 'user.name',          // Auto-generated label
            key: 'name',                 // Immediate key
            value: undefined             // The failing value
        }
    }


### `Joi.isError(err)`


Returns `true` if the error is a joi ValidationError.


### `Joi.ValidationError`


The ValidationError constructor. Useful for `instanceof` checks.


### Customizing error messages


#### `.messages(messages)` - Override specific error codes

    Joi.string().min(3).max(30).messages({
        'string.base': '{{#label}} must be text',
        'string.min': '{{#label}} must be at least {{#limit}} characters',
        'string.max': '{{#label}} cannot exceed {{#limit}} characters',
        'any.required': '{{#label}} is required'
    });

#### `.message(message)` - Override for last rule only

    Joi.string().min(3).message('Too short').max(30).message('Too long');

#### `.label(name)` - Set the field label

    Joi.string().label('Username').required();
    // Error: "Username" is required

#### `.error(err)` - Completely override the error

    // Static error
    Joi.string().error(new Error('Invalid input'));

    // Dynamic error
    Joi.string().error((errors) => {
        return new Error(`Got ${errors.length} validation errors`);
    });


### Error message template variables


Available in `.messages()` templates:

| Variable     | Description                           |
| ------------ | ------------------------------------- |
| `#label`     | Field label (auto or from `.label()`) |
| `#value`     | The failing value                     |
| `#key`       | The immediate object key              |
| `#limit`     | Rule argument (min, max, length)      |
| `#type`      | Expected type                         |
| `#name`      | Rule name                             |
| `#regex`     | Pattern source                        |
| `#valids`    | List of allowed values                |
| `#invalids`  | List of denied values                 |
| `#encoding`  | String encoding                       |


### Error codes by type


Common error codes:

| Code                    | When                                    |
| ----------------------- | --------------------------------------- |
| `any.required`          | Required field missing                  |
| `any.unknown`           | Unknown key in object                   |
| `any.invalid`           | Value in `.invalid()` list              |
| `any.only`              | Value not in `.valid()` list            |
| `string.base`           | Not a string                            |
| `string.empty`          | Empty string                            |
| `string.min`            | Below minimum length                    |
| `string.max`            | Above maximum length                    |
| `string.email`          | Invalid email                           |
| `string.pattern.base`   | Regex mismatch                          |
| `number.base`           | Not a number                            |
| `number.min`            | Below minimum                           |
| `number.max`            | Above maximum                           |
| `number.integer`        | Not an integer                          |
| `date.base`             | Not a valid date                        |
| `object.base`           | Not an object                           |
| `object.unknown`        | Unknown key                             |
| `array.base`            | Not an array                            |
| `array.min`             | Below minimum items                     |
| `array.includesRequiredUnknowns` | Missing required item type     |


### `.warning(code, [context])`


Emit a warning instead of an error. Warnings are collected but don't fail validation:

    const schema = Joi.string().warning('custom.deprecation', { alt: 'newField' });

    const { value, warning } = schema.validate('test', { warnings: true });
    // warning.details[0].type === 'custom.deprecation'


### `error.annotate([stripColors])`


Returns a string with the input annotated with error markers. Useful for debugging:

    const { error } = Joi.object({
        a: Joi.number()
    }).validate({ a: 'not a number' });

    console.log(error.annotate());
    // {
    //   "a" [1]: "not a number"
    // }
    //
    // [1] "a" must be a number

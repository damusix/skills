## Testing Patterns


Joi uses `@hapi/lab` as test runner and `@hapi/code` for assertions.


### Test runner configuration


The `npm test` command runs:

    lab -t 100 -a @hapi/code -L -Y

| Flag | Meaning |
| ---- | ------- |
| `-t 100` | Require 100% code coverage |
| `-a @hapi/code` | Use `@hapi/code` as assertion library |
| `-L` | Enable linting (via `@hapi/eslint-plugin`) |
| `-Y` | TypeScript type checking (compiles `test/index.ts`) |

There is no `.labrc.js` file; all options are in the `scripts.test` field of `package.json`.


### Test structure


    const Code = require('@hapi/code');
    const Lab = require('@hapi/lab');
    const Joi = require('..');
    const Helper = require('./helper');

    const internals = {};

    const { describe, it } = exports.lab = Lab.script();
    const { expect } = Code;

    describe('Joi.string()', () => {

        it('validates a string', () => {

            const schema = Joi.string();
            Helper.validate(schema, [
                ['hello', true],
                [123, false, {
                    message: '"value" must be a string',
                    path: [],
                    type: 'string.base',
                    context: { value: 123, label: 'value' }
                }]
            ]);
        });
    });

Note: Test files under `test/types/` import Joi from `'../..'` and Helper from `'../helper'`. Top-level test files import from `'..'` and `'./helper'`. An `internals = {}` declaration is always present even if unused.


### `Helper.validate(schema, [prefs], tests)`


Batch validation testing. The optional second argument is a validation options object (e.g. `{ abortEarly: false }`, `{ context: { x: 1 } }`).

Each test entry is `[value, pass, expected]`:

    Helper.validate(schema, [
        // [input, shouldPass] - when passing, asserts value === input
        ['valid-input', true],

        // [input, shouldPass, expectedCoercedValue] - asserts coerced value
        ['123', true, 123],

        // [input, shouldPass, Helper.skip] - skip value assertion for passing tests
        [funcValue, true, Helper.skip],

        // [input, shouldFail, expectedErrorDetailObject] - single error detail
        [null, false, {
            message: '"value" is required',
            path: [],
            type: 'any.required',
            context: { label: 'value' }
        }],

        // [input, shouldFail, expectedErrorMessageString] - just the message
        ['', false, '"value" is not allowed to be empty']
    ]);

With options:

    Helper.validate(schema, { abortEarly: false }, [
        [1, false, '"value" must be >= 10. "value" must be >= 100']
    ]);

    Helper.validate(schema, { context: { x: 22 } }, [
        [5, true],
        [50, false, '"value" must be less than ref:global:x']
    ]);

Internal behavior of `Helper.validate`:

- Validates each input twice: once with `{ debug: true, ...prefs }` and once with `prefs` alone, asserting both produce identical results.
- When `prefs` is `null` (no options passed), also runs the Standard Schema `schema['~standard'].validate(input)` and checks consistency.
- Roundtrips the schema through `schema.$_root.build(schema.describe())` to verify describe/build symmetry.
- **Failing tests must always provide an expected value** (string or object). Omitting the third element for a failing test throws `'Failing tests messages must be tested'`.
- When `abortEarly` is `false`, the expected value must be `{ message, details }` where `details` is the full array.
- When `abortEarly` is `true` (default), asserts `error.details` has length 1, and `error.message === error.details[0].message`, then deep-compares `error.details[0]` to the expected object.


### `Helper.equal(a, b)`


Deep equality check with `{ deepFunction: true, skip: ['$_temp', '$_root'] }`. Used to compare schema objects:

    Helper.equal(schema, Joi.valid(Joi.override, null));
    Helper.equal(schema, clone);


### `Helper.skip`


A Symbol used as the third element in a passing test tuple to skip value assertion. Useful when the output value cannot be compared with `expect().to.equal()` (e.g. functions):

    [Object.assign(() => {}, { c: 'test2' }), true, Helper.skip]


### Direct validation testing


    it('applies defaults', () => {

        const schema = Joi.string().default('hello');
        const { value } = schema.validate(undefined);
        expect(value).to.equal('hello');
    });

    it('returns error details', () => {

        const schema = Joi.number().min(5);
        const { error } = schema.validate(3);
        expect(error).to.be.an.error('"value" must be greater than or equal to 5');
        expect(error.details).to.equal([{
            message: '"value" must be greater than or equal to 5',
            path: [],
            type: 'number.min',
            context: { limit: 5, value: 3, label: 'value', key: undefined }
        }]);
    });

    it('checks error properties', () => {

        const err = Joi.valid('foo').validate('bar').error;
        expect(err).to.be.an.error();
        expect(err.isJoi).to.be.true();
        expect(Joi.isError(err)).to.be.true();
    });


### Testing `expect().to.throw()`


Used for API misuse and invalid arguments:

    expect(() => Joi.any().allow(undefined)).to.throw('Cannot call allow/valid/invalid with undefined');
    expect(() => Joi.number().alter('x')).to.throw('Invalid targets argument');


### Testing async/external validation


    it('validates externals', async () => {

        const schema = Joi.string().external((value) => {

            if (value === 'bad') {
                throw new Error('external fail');
            }

            return value + '!';
        });

        const result = await schema.validateAsync('good');
        expect(result).to.equal('good!');

        await expect(schema.validateAsync('bad')).to.reject('external fail');
    });


### Testing warnings


    it('returns warnings', () => {

        const result = schema.validate('hello');
        expect(result.warning).to.equal({
            message: 'You do not seem excited enough',
            details: [
                {
                    context: {
                        label: 'value',
                        value: 'hello'
                    },
                    message: 'You do not seem excited enough',
                    path: [],
                    type: 'special.excited'
                }
            ]
        });
    });


### Testing extensions


Local extension (extending a schema instance directly):

    it('extends string locally', () => {

        const special = Joi.string().extend({
            type: 'special',
            rules: {
                hello: {
                    validate(value, helpers, args, options) {

                        if (!/hello/.test(value)) {
                            return helpers.error('special.hello');
                        }

                        return value;
                    }
                }
            },
            messages: {
                'special.hello': '{{#label}} must say hello'
            }
        });

        expect(special.type).to.equal('special');
        expect(special.hello().validate('HELLO').error).to.be.an.error('"value" must say hello');
    });

Global extension (via `Joi.extend()`):

    it('validates custom type', () => {

        const custom = Joi.extend((joi) => ({
            type: 'myType',
            base: joi.string(),
            messages: {
                'myType.custom': '{{#label}} failed custom check'
            },
            rules: {
                custom: {
                    method() {
                        return this.$_addRule('custom');
                    },
                    validate(value, helpers) {

                        if (value !== 'expected') {
                            return helpers.error('myType.custom');
                        }

                        return value;
                    }
                }
            }
        }));

        const schema = custom.myType().custom();

        Helper.validate(schema, [
            ['expected', true],
            ['other', false, {
                message: '"value" failed custom check',
                path: [],
                type: 'myType.custom',
                context: { label: 'value', value: 'other' }
            }]
        ]);
    });


### TypeScript testing


TypeScript tests live in `test/index.ts` and are checked by Lab's `-Y` flag. They use `Lab.types` assertions:

    import * as Lab from '@hapi/lab';
    import * as Joi from '..';

    const { expect } = Lab.types;

Type assertions:

    // Assert a value has a specific type
    expect.type<Joi.StringSchema>(Joi.string());
    expect.type<Joi.ArraySchema<boolean[]>>(Joi.array().items(Joi.boolean()));
    expect.type<number>(value);

    // Assert a call produces a type error
    expect.error(Joi.alternatives().try(schemaArr));

Common patterns:

    // CustomValidator types
    const custom: Joi.CustomValidator<number> = (value, helpers) => {
        expect.type<number>(value);
        expect.type<Joi.Schema>(helpers.schema);
        expect.type<Joi.State>(helpers.state);
        expect.type<Joi.ValidationOptions>(helpers.prefs);
        expect.type<number>(helpers.original);
        expect.type<Function>(helpers.warn);
        expect.type<Function>(helpers.error);
        expect.type<Function>(helpers.message);
        return 1;
    };

    // ExternalValidationFunction types
    const external: Joi.ExternalValidationFunction<number> = (value, helpers) => {
        expect.type<number>(value);
        expect.type<Joi.Schema>(helpers.schema);
        expect.type<Joi.Schema | null>(helpers.linked);
        return 1;
    };

    // Standard Schema support
    import { StandardSchemaV1 } from "@standard-schema/spec";


### Test file organization


Tests mirror the lib structure:

| Test file                      | Tests                        |
| ------------------------------ | ---------------------------- |
| `test/base.js`                 | Common any() methods         |
| `test/types/any.js`            | any type specifics           |
| `test/types/string.js`         | String type and rules        |
| `test/types/number.js`         | Number type and rules        |
| `test/types/object.js`         | Object type and rules        |
| `test/types/array.js`          | Array type and rules         |
| `test/types/boolean.js`        | Boolean type and rules       |
| `test/types/binary.js`         | Binary type and rules        |
| `test/types/date.js`           | Date type and rules          |
| `test/types/function.js`       | Function type and rules      |
| `test/types/symbol.js`         | Symbol type and rules        |
| `test/types/alternatives.js`   | Alternatives type            |
| `test/types/link.js`           | Link type                    |
| `test/extend.js`               | Extension system             |
| `test/errors.js`               | Error handling               |
| `test/template.js`             | Template engine              |
| `test/ref.js`                  | References                   |
| `test/compile.js`              | Schema compilation           |
| `test/manifest.js`             | Manifest/describe            |
| `test/validator.js`            | Validator behavior           |
| `test/cache.js`                | Cache behavior               |
| `test/common.js`               | Common utilities             |
| `test/modify.js`               | Schema modification          |
| `test/trace.js`                | Debug tracing                |
| `test/values.js`               | Values container             |
| `test/isAsync.js`              | Async detection              |
| `test/index.ts`                | TypeScript type definitions  |


### Running tests


    npm test                         # Full suite with 100% coverage + lint + TS
    npx lab test/types/string.js     # Single file
    npx lab test/base.js -g "default" # Grep for specific tests
    npx lab -r html -o coverage.html -a @hapi/code  # HTML coverage report

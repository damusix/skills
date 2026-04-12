/* eslint-disable @typescript-eslint/no-require-imports */

const TsEslint = require('typescript-eslint');

module.exports = TsEslint.config(
    {
        files: ['**/*.ts', '**/*.cjs', '**/*.js']
    },
    ...TsEslint.configs.recommended,
    {
        ignores: ['dist/**', 'assets/built/**', 'node_modules/**']
    },
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unsafe-function-type': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
        }
    }
);

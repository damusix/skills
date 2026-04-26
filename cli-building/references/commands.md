# Commands


## Defining a Command

Every command file exports a default `defineCommand()`. This is non-negotiable — citty's type inference and lazy loading depend on it.

```typescript
import { defineCommand } from 'citty';

export default defineCommand({
    meta: {
        name: 'build',
        description: 'Build the project',
    },
    args: {
        target: {
            type: 'positional',
            description: 'Build target',
            required: true,
        },
        watch: {
            type: 'boolean',
            description: 'Watch for changes',
        },
    },
    run({ args }) {
        console.log(`Building ${args.target}, watch: ${args.watch}`);
    },
});
```


## Argument Types

| Type | Description | Example Usage |
|------|-------------|---------------|
| `positional` | Unnamed, consumed in order | `cli build src` |
| `string` | Named string option | `cli --output dist` |
| `boolean` | Flag, supports `--no-` prefix | `cli --verbose`, `cli --no-color` |
| `enum` | Constrained to `options` array | `cli --level warn` |


### Positional

```typescript
args: {
    file: {
        type: 'positional',
        description: 'Input file path',
        required: true,
    },
}
```


### String with Alias

```typescript
args: {
    output: {
        type: 'string',
        description: 'Output directory',
        default: 'dist',
        alias: ['o'],
        valueHint: 'dir',
    },
}
```

`valueHint` controls help display: `--output=<dir>`.


### Boolean with Negation

```typescript
args: {
    color: {
        type: 'boolean',
        description: 'Colorize output',
        negativeDescription: 'Disable colored output',
        default: true,
    },
}
```

When `default: true` or `negativeDescription` is set, `--no-color` is shown in help.


### Enum

```typescript
args: {
    level: {
        type: 'enum',
        description: 'Log level',
        options: ['debug', 'info', 'warn', 'error'] as const,
        default: 'info',
    },
}
```

Use `as const` on the options array for narrow type inference.


## Subcommands

Register subcommands with lazy imports for fast startup:

```typescript
import { defineCommand } from 'citty';

export default defineCommand({
    meta: {
        name: 'db',
        description: 'Database tools',
    },
    subCommands: {
        migrate: () => import('./migrate').then((m) => m.default),
        seed: () => import('./seed').then((m) => m.default),
        reset: () => import('./reset').then((m) => m.default),
    },
});
```

Subcommands nest recursively — a subcommand can have its own subcommands.


## Default Subcommand

Run a specific subcommand when none is given:

```typescript
export default defineCommand({
    meta: { name: 'db' },
    subCommands: {
        status: () => import('./status').then((m) => m.default),
        migrate: () => import('./migrate').then((m) => m.default),
    },
    default: 'status',
});
```

You **cannot** have both `run` and `default` on the same command — citty throws `E_DEFAULT_CONFLICT`.


## Hidden Commands and Aliases

```typescript
export default defineCommand({
    meta: {
        name: 'debug-internals',
        description: 'Internal debugging tools',
        hidden: true,
        alias: ['di'],
    },
    run() {
        // hidden from help but still callable
    },
});
```


## Lifecycle: setup → run → cleanup

```typescript
export default defineCommand({
    meta: { name: 'deploy' },
    args: {
        environment: {
            type: 'enum',
            options: ['dev', 'staging', 'prod'] as const,
            required: true,
        },
    },
    setup({ args }) {
        // Preconditions: check auth, validate config
        if (args.environment === 'prod') {
            // verify extra permissions
        }
    },
    run({ args }) {
        // Main logic
    },
    cleanup() {
        // Always runs, even if run() throws
        // Teardown: close connections, remove temp files
    },
});
```


## Commands that Need User Input

Delegate to prompt modules — don't inline `@clack/prompts` calls in commands:

```typescript
import { defineCommand } from 'citty';
import { promptDeployTarget } from '../prompts/deploy-target';

export default defineCommand({
    meta: { name: 'deploy', description: 'Deploy to environment' },
    args: {
        environment: {
            type: 'enum',
            options: ['dev', 'staging', 'prod'] as const,
        },
    },
    async run({ args }) {
        const environment = args.environment ?? await promptDeployTarget();
        console.log(`Deploying to ${environment}`);
    },
});
```

This pattern lets args override prompts — if the user passes `--environment prod`, skip the interactive prompt.


## Case-Agnostic Arg Access

Citty's parsed args use a Proxy. Both forms work interchangeably:

```typescript
args['output-dir']  // kebab-case
args.outputDir      // camelCase
```

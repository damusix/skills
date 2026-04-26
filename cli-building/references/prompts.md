# Prompts — `@clack/prompts`


## Pattern: Reusable Prompt Module

Each file in `cli/prompts/` exports a typed async function that composes one or more `@clack/prompts` calls and returns a typed result.

```typescript
// cli/prompts/deploy-target.ts
import { select, confirm, isCancel, cancel } from '@clack/prompts';

interface DeployConfig {
    environment: 'dev' | 'staging' | 'prod';
    confirmed: boolean;
}

export async function promptDeployTarget(): Promise<DeployConfig> {
    const environment = await select({
        message: 'Select deployment target',
        options: [
            { value: 'dev' as const, label: 'Development' },
            { value: 'staging' as const, label: 'Staging' },
            { value: 'prod' as const, label: 'Production', hint: 'requires approval' },
        ],
    });

    if (isCancel(environment)) {
        cancel('Deployment cancelled');
        process.exit(0);
    }

    const confirmed = await confirm({
        message: `Deploy to ${environment}?`,
    });

    if (isCancel(confirmed)) {
        cancel('Deployment cancelled');
        process.exit(0);
    }

    return { environment, confirmed };
}
```


## isCancel — Never Skip

Every `@clack/prompts` call can return a cancel symbol when the user presses Ctrl+C. Always check:

```typescript
const value = await text({ message: 'Enter name' });

if (isCancel(value)) {
    cancel('Operation cancelled');
    process.exit(0);
}
```

Extract a helper if the repetition bothers you:

```typescript
// cli/lib/prompt-helpers.ts
import { isCancel, cancel } from '@clack/prompts';

export function exitOnCancel<T>(value: T | symbol, message = 'Cancelled'): T {
    if (isCancel(value)) {
        cancel(message);
        process.exit(0);
    }
    return value;
}
```

```typescript
// usage
import { text } from '@clack/prompts';
import { exitOnCancel } from '../lib/prompt-helpers';

const name = exitOnCancel(await text({ message: 'Enter name' }));
```


## Flow Boundaries with intro/outro

Use `intro()` and `outro()` to wrap a complete interactive flow:

```typescript
import { intro, outro, text, select, isCancel, cancel } from '@clack/prompts';

export async function promptProjectSetup() {
    intro('Project Setup');

    const name = await text({
        message: 'Project name',
        placeholder: 'my-project',
        validate: (v) => {
            if (!v) return 'Name is required';
            if (!/^[a-z0-9-]+$/.test(v)) return 'Use lowercase letters, numbers, hyphens';
        },
    });

    if (isCancel(name)) {
        cancel('Setup cancelled');
        process.exit(0);
    }

    const template = await select({
        message: 'Choose template',
        options: [
            { value: 'minimal', label: 'Minimal' },
            { value: 'full', label: 'Full stack' },
        ],
    });

    if (isCancel(template)) {
        cancel('Setup cancelled');
        process.exit(0);
    }

    outro('Setup complete!');

    return { name, template };
}
```


## Spinner for Async Work

```typescript
import { spinner } from '@clack/prompts';

const s = spinner();
s.start('Installing dependencies');
await installDeps();
s.stop('Dependencies installed');
```


## Tasks for Sequential Operations

```typescript
import { tasks } from '@clack/prompts';

await tasks([
    {
        title: 'Creating project structure',
        task: async () => {
            await createDirs();
            return 'Project structure created';
        },
    },
    {
        title: 'Installing dependencies',
        task: async () => {
            await runInstall();
            return 'Dependencies installed';
        },
    },
]);
```


## Multiselect

```typescript
import { multiselect, isCancel, cancel } from '@clack/prompts';

const features = await multiselect({
    message: 'Select features',
    options: [
        { value: 'eslint', label: 'ESLint', hint: 'recommended' },
        { value: 'prettier', label: 'Prettier' },
        { value: 'tests', label: 'Testing setup' },
    ],
    required: true,
});

if (isCancel(features)) {
    cancel('Cancelled');
    process.exit(0);
}
```


## When to Use Prompts vs Args

| Scenario | Use |
|----------|-----|
| Value always known upfront | Citty arg (positional, flag, enum) |
| Value needs discovery/browsing | `@clack/prompts` (select, autocomplete, path) |
| Confirmation before destructive action | `@clack/prompts` confirm |
| Multiple values from a list | `@clack/prompts` multiselect |
| Value optional, prompt if missing | Citty arg + fallback to prompt |

The "arg + fallback to prompt" pattern is the most common:

```typescript
const env = args.environment ?? await promptEnvironment();
```


## Documentation Source

If something isn't covered here, consult the upstream docs:

- `@clack/prompts`: https://bomb.sh/docs/clack/basics/getting-started/
- `@clack/core` (low-level primitives): https://bomb.sh/docs/clack/core/getting-started/

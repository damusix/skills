# Sidecar Setup


## The CLI as a Side-Tool

The CLI lives under `cli/` and is not the primary project. It might be a dev tool, a management script, a migration runner, or an admin interface. The host project owns the root `package.json`, `tsconfig.json`, etc.


## package.json Bin Entry

Add the CLI as a bin entry pointing to the compiled (or tsx-executed) entrypoint:

```json
{
    "bin": {
        "my-cli": "./cli/index.ts"
    }
}
```

If using a build step that compiles to `dist/`:

```json
{
    "bin": {
        "my-cli": "./dist/cli/index.js"
    }
}
```

For local development without building, use `tsx` directly:

```json
{
    "scripts": {
        "cli": "npx tsx cli/index.ts"
    }
}
```


## Dependencies

CLI dependencies go in the appropriate section based on the CLI's role:

| Role | Where |
|------|-------|
| Dev-only tool (migrations, codegen, seeding) | `devDependencies` |
| Ships with the app (admin CLI, management tool) | `dependencies` |

```json
{
    "devDependencies": {
        "citty": "^0.2.2",
        "@bomb.sh/tab": "^latest",
        "@clack/prompts": "^latest"
    }
}
```


## TypeScript Config

If the host project's `tsconfig.json` already covers `cli/`, no changes needed. If it excludes it (e.g., Next.js projects that scope to `src/`), either:

**Option A**: Extend the existing config with a CLI-specific one:

```json
// cli/tsconfig.json
{
    "extends": "../tsconfig.json",
    "include": ["./**/*.ts"],
    "compilerOptions": {
        "outDir": "../dist/cli"
    }
}
```

**Option B**: Add `cli/` to the host project's `include`:

```json
{
    "include": ["src/**/*.ts", "cli/**/*.ts"]
}
```


## Monorepo Setup

In a monorepo, the CLI can be its own package:

```
packages/
    cli/
        package.json    # name: "@myorg/cli"
        index.ts
        commands/
        prompts/
        lib/
    app/
    api/
```

Or it can stay in the root alongside other packages — whichever fits the project structure.

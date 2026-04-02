---
name: google-zx-scripting
description: "Writes and executes JavaScript-based shell scripts using Google's zx library. Use when writing shell scripts, automation, build tools, file processing, CLI tools, deployment scripts, data pipelines, or batch operations. Also covers piping, streams, parallel execution, retries, cross-platform scripting, built-in fs utilities, and minimist argument parsing."
---

# Google ZX Scripting


Use this skill when writing scripts with Google's `zx` library — the tool that makes shell scripting with JavaScript/TypeScript productive and safe. Read only the reference file(s) needed for the task.

## Quick Start

All zx scripts use the **lite** entry point for portability. Scripts are standalone `.mjs` files — no project setup required.

    #!/usr/bin/env npx zx

    import { $, fs, path, glob, chalk } from 'zx/core';

    const files = await glob('src/**/*.ts');
    await $`eslint ${files}`;

Run directly:

    chmod +x script.mjs && ./script.mjs
    # or
    npx zx script.mjs

## Critical Rules

1. **Always use `zx/core`** — never bare `zx`. Avoids the heavy CLI wrapper.
2. **Template literals auto-escape** — `` $`echo ${userInput}` `` is safe. Never manually quote interpolated variables.
3. **Arrays expand correctly** — `` $`cmd ${arrayOfArgs}` `` expands each element as a separate quoted argument.
4. **Non-zero exits throw** — use `.nothrow()` to suppress when you expect failures (e.g., `grep` with no matches).
5. **`within()` for isolation** — creates an async scope with its own `$.cwd` and `$.env`. Essential for parallel tasks.
6. **Pipe with `.pipe()`** — use `` $`cmd1`.pipe($`cmd2`) `` instead of shell `|`.
7. **Prefer zx builtins** — `glob()` over `find`, `fs` over `cat`/`cp`/`mv`, `fetch()` over `curl`.
8. **`cd()` is global** — use `within()` or `$({cwd: '/path'})` for scoped directory changes.
9. **Scripts must be `.mjs`** — for top-level `await` support without bundler config.

## Reference Map

| Need | File |
|------|------|
| `$`, ProcessPromise, ProcessOutput, configuration, piping, streams | `references/core-api.md` |
| Ad-hoc scripts, CLI tools, build scripts, deployment, project scaffolding | `references/scripting-patterns.md` |
| File processing, data pipelines, batch ops, AI scripts, log analysis | `references/processing-recipes.md` |

## Task Routing

- Writing a quick one-off command or shell automation -> `references/scripting-patterns.md`
- Building a build/deploy/CI script -> `references/scripting-patterns.md`
- Processing files, data, logs, or batch operations -> `references/processing-recipes.md`
- Need API details for `$`, pipes, streams, config -> `references/core-api.md`
- Combining multiple patterns (e.g., build + process) -> read both relevant files

## Import Cheatsheet

    // Core — always start here
    import { $, fs, path, glob, chalk } from 'zx/core';

    // Additional utilities (import individually as needed)
    import { spinner, retry, question, echo, sleep, within,
             stdin, tmpdir, tmpfile, which, ps, kill,
             quote, YAML, argv, fetch } from 'zx/core';

## Validation Checkpoints

Before executing destructive or bulk operations, always verify scope:

    // Verify glob matches before bulk processing
    const files = await glob('src/**/*.ts');
    console.log(`Found ${files.length} files`);
    if (files.length === 0) throw new Error('No files matched — check glob pattern');
    if (files.length > 500) throw new Error(`Too many files (${files.length}) — narrow the glob`);

    // Dry-run flag for destructive operations
    const dryRun = argv['dry-run'] ?? false;
    for (const file of files) {
        if (dryRun) { console.log(`[dry-run] would delete ${file}`); continue; }
        await fs.rm(file);
    }

For parallel operations, use `Promise.allSettled()` to handle partial failures:

    const results = await Promise.allSettled(
        files.map(f => within(async () => $`process ${f}`))
    );
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
        console.error(chalk.red(`${failed.length}/${results.length} tasks failed`));
        failed.forEach(r => console.error(r.reason));
        process.exitCode = 1;
    }

## Conventions for Generated Scripts

1. **Shebang line**: Always include `#!/usr/bin/env npx zx` as the first line
2. **Verbose off**: Set `$.verbose = false` before main logic to suppress command echoing
3. **Error handling**: Use the `main().catch()` pattern — wrap logic in `async function main()`, then call `main().catch(err => { console.error(chalk.red(err.message)); process.exit(1); })`
4. **Output colors**: Use `chalk.green()` for success, `chalk.red()` for errors, `chalk.yellow()` for warnings, `chalk.dim()` for secondary info
5. **Progress**: Use `spinner()` for long-running operations in interactive contexts
6. **Arguments**: Use `argv` (pre-parsed `minimist`) for CLI argument handling
7. **Temp files**: Use `tmpdir()` and `tmpfile()` — they auto-clean on exit
8. **Parallelism**: Use `Promise.all()` with `within()` for parallel operations that need isolation

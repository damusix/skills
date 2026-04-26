---
name: cli-building
description: "Use when building TypeScript CLIs. Guides command structure, interactive prompts, and tab completion using citty, `@clack/prompts`, and `@bomb.sh/tab`."
---

# Citty CLI

## Quick Start

    npm install citty @bomb.sh/tab @clack/prompts

## Critical Rules

1. **Every command exports default `defineCommand()`** — no exceptions
2. **Lazy-load subcommands** — `() => import('./cmd').then(m => m.default)`
3. **Check `isCancel()` after every `@clack/prompts` call** — never skip
4. **Citty handles all arg parsing** — no external parsers
5. **Architecture is opt-in** — only suggest `cli/` structure when the user asks for project layout or scaffolding. Single-file CLIs are valid.

## Architecture (only when user asks for structure)

See [architecture](references/architecture.md) for the full `cli/` layout with commands, prompts, and lib directories. Do not impose this structure unless the user explicitly asks for scaffolding or project organization.

## Workflow

1. Define commands — [commands](references/commands.md)
2. Add prompts if interactive — [prompts](references/prompts.md)
3. Wire tab completion — [tab-completion](references/tab-completion.md)
4. Scaffold `cli/` if multi-command — [architecture](references/architecture.md)
5. Configure bin entry — [sidecar setup](references/sidecar-setup.md)

## References

- [Architecture](references/architecture.md) — Structure and responsibilities
- [Entrypoint](references/entrypoint.md) — runMain + tab completion wiring
- [Commands](references/commands.md) — defineCommand, args, subcommands
- [Prompts](references/prompts.md) — `@clack/prompts` reusable modules
- [Tab Completion](references/tab-completion.md) — `@bomb.sh/tab` adapter
- [Sidecar Setup](references/sidecar-setup.md) — bin entry, build config
- [Citty API](references/citty-api.md) — Resolvable, plugins, CLIError

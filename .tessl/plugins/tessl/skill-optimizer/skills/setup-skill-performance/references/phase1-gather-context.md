# Phase 1: Find the Plugin

## 1.1 Find the plugin

Look for a plugin manifest (`.tessl-plugin/plugin.json`) in the current directory or a parent/sibling directory. Exclude `.tessl/` cache directories:
```bash
find . -path "*/.tessl-plugin/plugin.json" -not -path "*/node_modules/*" -not -path "*/.tessl/*" 2>/dev/null | head -10
```

If the user provides a path inside a `.tessl/plugins/` directory (an installed plugin cache), stop and warn them: that path is Tessl's local install cache — running evals from there won't work and changes would be overwritten on the next `tessl install`. Offer two options: point to the original plugin source, or copy the plugin out of `.tessl/plugins/` to a new location (`cp -r .tessl/plugins/<workspace>/<plugin> ./<plugin>`).

If multiple plugins are found outside `.tessl/`, ask the user which one to evaluate. If none are found, explain that this skill evaluates a packaged plugin and suggest `tessl plugin new` to get started.

## 1.2 Verify login

```bash
tessl whoami
```

If not logged in, ask the user to run `tessl login` before continuing.

## 1.3 Check for existing scenarios

Check if scenarios already exist in the plugin's `evals/` directory:
```bash
ls <plugin-dir>/evals/*/task.md 2>/dev/null
```

If scenarios exist, warn the user:

> "You already have scenarios in `evals/`. Options:
> 1. **Add more** — generate new scenarios alongside existing ones
> 2. **Replace all** — generate new scenarios and replace existing ones
> 3. **Skip generation** — just run evals on existing scenarios
>
> What would you prefer?"

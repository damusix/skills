# Phase 3: Fixtures and setup scripts

Eval scenarios start in an empty working directory unless they declare environment preparation. Two kinds exist:

- **Fixtures** — static context installed into the working directory before the agent runs. Declared as a named record under `fixtures` in `scenario.json`.
- **Setup scripts** — shell scripts that run after fixtures install and before the agent task begins. Either declared as `setup: ["./setup.sh"]` in `scenario.json`, or auto-detected from a `setup.sh` placed next to the scenario.

This reference covers when each is needed, how to source/generate them silently when possible, and the skip rules that protect user intent.

## Schema reminder

A `scenario.json` with both kinds of preparation looks like:

```json
{
  "fixtures": {
    "codebase": {
      "type": "commit",
      "repoUrl": "https://github.com/acme/example.git",
      "ref": "main"
    }
  },
  "setup": ["./setup.sh"]
}
```

Fixture types:
- `commit` — `{ type: "commit", repoUrl, ref, installPath?, exclude? }` — git snapshot at a ref.
- `directory` — `{ type: "directory", path, installPath }` — local directory copied in.

## Detection rules

For each scenario, read its `task.md`, `criteria.json`, and the parent plugin's `SKILL.md` / `docs/` to classify needs.

### Fixture-warranted signals

Fire if **any** of these apply:
- The plugin's `SKILL.md` talks about modifying or refactoring existing code, or uses phrases like "this codebase", "your repo", or names file paths the user is expected to edit.
- The scenario's `task.md` references files that must already exist — e.g. "fix the bug in `src/foo.ts`", "update the migration in `db/`".
- The rubric in `criteria.json` checks for edits to existing files rather than from-scratch creation.

### Setup-script-warranted signals

Fire if **any** of these apply:
- The plugin mentions an external CLI or dependency the agent must run (`npm install`, `pip install`, `brew install`, `cargo build`).
- The task assumes a running service, database, env var, credentials, or migration state that can't be expressed as static files.

### Skip rules (always honour user intent)

Do **not** generate or overwrite when:
- `scenario.json` already declares a `fixtures` record — leave it alone.
- `scenario.json` already declares `setup`, **or** a `setup.sh` already exists next to the scenario — leave it alone.

Skip rules apply per-scenario. A plugin with five scenarios may need fixture generation on three of them and nothing on the other two.

## Fixture sourcing — silent inference first

When the fixture signal fires for a scenario:

1. **Scan the plugin silently.** Look in `SKILL.md`, the plugin's `docs/`, and any `README.md` for:
   - A repo URL (anything matching `https://github.com/…` or a `git@github.com:…` reference) together with an obvious ref (branch name, tag, or commit), OR
   - A sample directory path inside the plugin (e.g. `examples/`, `fixtures/`).
2. **If a plausible source is found**, write it into `scenario.json` under `fixtures.<name>` using the schema above. Name the fixture descriptively — `codebase` for the primary repo snapshot is conventional; use `examples` or similar for directory fixtures.
3. **If nothing plausible is found**, ask the user once:

   > "Scenario `<slug>` looks like it needs an existing codebase to operate on, but I couldn't find a repo URL or sample path in the plugin. Want to provide one (`<repo-url>#<ref>` or a local directory path), or skip fixture generation for this scenario?"

4. **If the user declines or can't provide a source**, skip fixture generation for that scenario, record it in the pre-run summary, and continue. Do not stop the phase — the user has explicitly opted into a degraded eval.

Be silent when signals are clear. Only ask when sourcing genuinely can't be inferred.

## Setup-script generation

When the setup-script signal fires for a scenario:

1. **Generate `setup.sh` next to the scenario** (in the same directory as `scenario.json` / `task.md`). The eval system auto-detects this file — there's no need to declare it in `scenario.json` unless you want to be explicit.
2. **Script content**: the minimum init commands implied by the signal. Include a shebang on the first line — the scenario lint rule warns without it.

   ```bash
   #!/bin/bash
   set -euo pipefail

   npm install
   ```

3. **`chmod +x setup.sh`** after writing so the eval runner can execute it.
4. **If the signal isn't specific enough to write a concrete script** (e.g. you can see the plugin expects a database but not which migrations to run), ask the user to confirm the commands before writing:

   > "Scenario `<slug>` looks like it needs setup before the agent runs. My best guess is:
   >
   > ```bash
   > #!/bin/bash
   > set -euo pipefail
   > npm install
   > ```
   >
   > Use this, or do you want to provide different commands?"

## Pre-run summary

After processing all scenarios — and **before** kicking off `tessl eval run` — show the user one concise summary so they can catch wrong inferences early:

```
Generated 2 fixtures and 1 setup script across 4 scenarios.
  - checkout-flow: fixture (commit: acme/example#main), setup.sh (npm install)
  - webhook-setup: fixture (commit: acme/example#main)
  - custom-scenario: fixture (user-declared), setup.sh (user-declared)
  - empty-state: no preparation needed
```

For scenarios where skip rules fired (a `fixtures` record, `setup` array, or `setup.sh` was already present), list each as `user-declared` rather than `no preparation needed`, so the user can confirm their declarations were respected and catch any mismatches.

If any scenario was skipped because the user declined to provide a source, list it here so the user knows the eval will run that scenario in an empty workdir.


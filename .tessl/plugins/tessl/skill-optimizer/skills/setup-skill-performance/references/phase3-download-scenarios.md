# Phase 3: Download Scenarios

## 3.1 Download to disk

Download the generated scenarios using the run ID from Phase 2:
```bash
tessl scenario download --last -o <plugin-dir>/evals/
```

Use `--strategy merge` to add new scenarios alongside existing ones — safe to use even on a first download when `evals/` is empty (merge is the default):
```bash
tessl scenario download --last -o <plugin-dir>/evals/ --strategy merge
```

Use `--strategy replace` only if the user explicitly asked to replace existing scenarios.

## 3.2 Verify the download

```bash
ls <plugin-dir>/evals/*/task.md
```

Show the user the downloaded scenario structure:

```
Downloaded scenarios:
  evals/
    checkout-flow/
      task.md
      criteria.json
      scenario.json
    webhook-setup/
      task.md
      criteria.json
      scenario.json
```

## 3.3 Quality-check scenarios before running

Before asking the user, **read each `criteria.json` and `task.md` yourself** and flag these common problems:

**Rubric anti-patterns to catch:**
1. **Answer leakage** — Does `task.md` contain specific values (version numbers, URLs, class names) that are also rubric criteria? If a criterion just checks whether the agent copied a value from the task prompt, it's a free point. Remove the value from the task or remove the criterion.
2. **Double-counting** — Do two criteria reward the same underlying change? (e.g., "uses recommended config" and "removes deprecated config" for a single substitution). Merge them into one criterion.
3. **Free points** — Is `no_unrelated_changes` included as a criterion? This scores 1 on nearly every solution and doesn't discriminate. Remove it unless the scenario specifically tests scope discipline.

Present your findings and offer review options:

> "You can also:
> 1. **Review task.md** — see what the agent will be asked to do
> 2. **Review criteria.json** — see what the rubric checks for
> 3. **Edit criteria weights** — adjust which criteria matter most
> 4. **Proceed to eval run** — use the scenarios as-is"

If the user wants to review, read and display the relevant files. Apply any edits they request.

## 3.4 Detect fixture and setup-script needs

Before kicking off the eval run, check each scenario for missing environment preparation it clearly needs. This step infers fixtures and setup scripts silently when the plugin content makes the source obvious, and only prompts the user when sourcing genuinely can't be determined.

Read [references/phase3-fixtures-and-setup.md](phase3-fixtures-and-setup.md) for:

- Fixture-warranted and setup-script-warranted signals
- Skip rules (never overwrite user-declared `fixtures` / `setup` / existing `setup.sh`)
- Silent inference + decline path for fixture sourcing
- `setup.sh` generation (with shebang + `chmod +x`)
- The pre-run summary format

**Before moving to Phase 4**, show the pre-run summary so the user can catch wrong inferences:

```
Generated X fixtures and Y setup scripts across Z scenarios.
  - <scenario>: <what was generated, or "no preparation needed">
  ...
```

If the user skipped fixture generation on any scenario (declined to provide a source), list it explicitly so they know that scenario will run in an empty workdir.

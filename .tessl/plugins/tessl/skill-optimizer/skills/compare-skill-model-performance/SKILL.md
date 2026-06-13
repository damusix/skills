---
name: compare-skill-model-performance
description: Run task evals across multiple Claude models, compare results side-by-side, and optimise. Use when you want to benchmark a skill across models, compare haiku vs sonnet vs opus performance, run multi-model comparison or benchmark reports, identify model-specific gaps versus universal plugin gaps, evaluate whether a skill works for all model tiers, or validate a skill before publishing it to the registry.
---

# Review Model Performance

**Models tested by default:** `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6` (cheapest to most capable)

**Eval command:** `tessl eval run <path/to/plugin> --agent=... --label <run-label>`

## Run labels

Every `tessl eval run` invocation MUST include `--label <run-label>` so the run is identifiable in `tessl eval list`. The label is a short, human-readable description of what the run is about — not a structured ID.

Compose `<run-label>` from whatever helps you recognise the run later when scanning the list. Typical ingredients:

- **Eval type** — e.g. `activation`, `baseline`, `initial evals`, `verification`
- **What was being tested or changed** — e.g. `description rewrite`, `plan-solution fixes`, `clean scenario`
- **Model in parens, when comparing models** — e.g. `(haiku-4-5)`, `(sonnet-4-6)`
- **Version when iterating** — e.g. `v0.5.0`, `v4`

Examples:
- `repro-clean-scenario`
- `task-prep v0.3.0 baseline`
- `task-prep v0.5.0 plan-solution fixes`
- `v4-final-verification`
- `skill-insights activation (haiku-4-5)`
- `skill-insights initial evals (haiku-4-5)`

Keep it concise — what the run was about should be obvious without opening it.

---

## Phase 1: Identify the plugin

### 1.1 Find the plugin

Look for a plugin manifest (`.tessl-plugin/plugin.json`) in the current directory or a parent/sibling directory. Exclude `.tessl/` cache directories:
```bash
find . -path "*/.tessl-plugin/plugin.json" -not -path "*/node_modules/*" -not -path "*/.tessl/*" 2>/dev/null | head -10
```

If the user provides a path inside a `.tessl/plugins/` directory (an installed plugin cache), stop and warn them: that path is Tessl's local install cache — running evals from there won't work and changes would be overwritten on the next `tessl install`. Offer two options: point to the original plugin source, or copy the plugin out of `.tessl/plugins/` to a new location (`cp -r .tessl/plugins/<workspace>/<plugin> ./<plugin>`).

If multiple plugins are found outside `.tessl/`, ask the user which one to evaluate. If none are found, explain that this skill evaluates a packaged plugin and suggest `tessl plugin new` to get started.

### 1.2 Verify eval scenarios exist

```bash
ls <plugin-dir>/evals/*/task.md 2>/dev/null
```

If no scenarios exist, inform the user and provide the quickest path to generate them:
```bash
tessl scenario generate <path/to/plugin> --count=3
tessl scenario download --last
mv ./evals/ <plugin-dir>/evals/
```
Note that scenario generation takes roughly 1–2 minutes per scenario. Also mention the `setup-skill-performance` skill for a guided walkthrough.

If scenarios exist, read the `task.md` from each scenario directory and list them:
```
Found N scenarios:
  - <scenario-slug>: <one-line description from task.md>
  - <scenario-slug>: ...
```

### 1.3 Verify login

```bash
tessl whoami
```

If not logged in, ask the user to run `tessl login` before continuing.

---

## Phase 2: Confirm run configuration

### 2.1 Models

Confirm the default model set with the user: `claude-haiku-4-5` (fast/cheap), `claude-sonnet-4-6` (default), `claude-opus-4-6` (most capable). This runs **3 sequential eval jobs**. Each scenario takes roughly 10–15 minutes per model, so with N scenarios expect around N×30–45 minutes total. Ask whether to proceed with all three or a subset.

### 2.2 Number of runs

Ask whether to run each scenario once (default, good for a first pass) or three times (recommended before publishing — triples the time but gives more stable averages). Remind the user of the time implications given N scenarios and 3 models.

If they choose more than 1, add `--runs=<n>` to all eval run commands in Phase 3.

---

## Phase 3: Run evals across models

Run models **one at a time, fully completing each before starting the next**. Do NOT start multiple eval runs back-to-back — even without bash `&` or background jobs, kicking off all three then polling them causes them to execute concurrently on the server, which inflates cost and creates noisy interactions between runs.

For each model in your chosen set, in order:

1. **Start** the eval:
   ```bash
   tessl eval run <path/to/plugin> --agent=claude:<model> [--runs=<n>] --label <run-label>
   ```
2. **Capture** the eval run ID from the output (`Eval run started: <id>`). Store it mapped to the model name for Phase 5.
3. **Share** the browser monitoring URL with the user (`https://tessl.io/eval-runs/<id>`).
4. **Poll this run to completion** (see Phase 4) before looping to the next model.

Update the user as each model finishes (e.g., "✔ haiku complete (`<id>`). Starting sonnet…").

---

## Phase 4: Poll for completion (per model)

For the current model's run, poll with `tessl eval view <id>` every few minutes until you see `Status: ✔ Completed` or `Status: ✖ Failed`. Only then loop back to Phase 3 to start the next model.

If a run fails, retry it:
```bash
tessl eval retry <id>
```

Once every model in the chosen set has reached `Completed`, proceed to Phase 5.

---

## Phase 5: Collect and compare results

Fetch full results for each run:
```bash
tessl eval view <id> --json
```

Parse both the **baseline (without skill)** and **with skill** scores for every scenario and criterion.

### 5.1 Overall summary table

```
Model Comparison — <plugin-name>

  Model                     Without Skill   With Skill   Delta
  ─────────────────────────────────────────────────────────────
  claude:claude-haiku-4-5       XX%            YY%       +ZZpp
  claude:claude-sonnet-4-6      XX%            YY%       +ZZpp
  claude:claude-opus-4-6        XX%            YY%       +ZZpp
```

### 5.2 Per-scenario breakdown

For each scenario, show its name, a one-line description (from task.md), and both scores per model:

```
Scenario: <slug>
What it tests: <description>

  Model       Without Skill   With Skill   Delta
  ─────────────────────────────────────────────
  haiku           XX%           YY%        +ZZpp
  sonnet          XX%           YY%        +ZZpp
  opus            XX%           YY%        +ZZpp
```

### 5.3 Per-criterion breakdown (with skill scores)

Use symbols: ✅ ≥ 80% · 🟡 ≥ 50% · 🔴 < 50%

```
Criterion Breakdown — with skill

  Criterion               haiku    sonnet    opus
  ─────────────────────────────────────────────────
  checks_prerequisites    ✅100%   ✅100%   ✅100%
  browses_commits         🔴 0%   🟡 33%   ✅100%
  ...
```

---

## Phase 6: Diagnose and interpret

### 6.1 Baseline interpretation

Before discussing the skill's impact, note what the without-skill scores reveal: high baselines (≥80%) mean the skill adds little; low baselines (<50%) are where the skill earns its place; baselines that diverge across models indicate which tier benefits most from the skill.

### 6.2 Classify failing criteria

For criteria that score poorly (with skill):

- **"Universal Failure" pattern (all models fail):** Plugin gap — instructions are missing, ambiguous, or conflicting. Highest priority.
- **"Capability Gradient" pattern (haiku fails, sonnet/opus pass):** Instructions too implicit for weaker models. Fix: simpler, more explicit phrasing.
- **"Model Anomaly" pattern (single-model anomaly):** Likely eval variance. Note but don't prioritize.
- **"Regression" pattern (without-skill outperforms with-skill):** The skill is actively confusing the model. High priority regardless of which model it affects.

### 6.3 Model recommendation

Give a plain-language summary of the combined baseline + with-skill picture for each model, calling out which scenarios show the largest delta, any regressions, and whether the skill is earning its place across the tested model range.

---

## Phase 7: Recommend next steps

**If regressions exist on any model:** Recommend fixing before publishing. Suggest running the `optimize-skill-performance` skill against the affected run IDs.

**If haiku-specific gaps only:** Note that the skill works well for sonnet and opus users, and offer to suggest specific wording changes to simplify instructions for haiku.

**If all models score well (≥ 80% with skill):**
```bash
tessl plugin publish <path/to/plugin>
```

**If results are variable / runs=1 was used:** Recommend re-running with `--runs=3` before publishing to average out variance.

**Always offer:** "Want me to re-run the comparison after any fixes to verify improvement?"

---

## When to stop

Stop when:
- The comparison tables, per-scenario breakdown, and diagnosis have been presented
- The user has a clear picture of which scenarios/criteria need attention and for which models
- The user has decided on next steps (fix → re-run, or proceed to publish)

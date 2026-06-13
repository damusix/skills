---
name: compare-skill-model-performance
description: Run task evals across multiple Claude models, compare results side-by-side, and optimise. Use when you want to understand how a skill performs across different models, identify model-specific gaps versus universal tile issues, or validate a skill before publishing it to the registry.
---

# Review Model Performance

**Models tested by default:** `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6` (cheapest to most capable)

**Eval command:** `tessl eval run <path/to/tile> --agent=...`

---

## Phase 1: Identify the tile

### 1.1 Find the tile

Look for a `tile.json` in the current directory or a parent/sibling directory. Exclude `.tessl/` cache directories:
```bash
find . -name "tile.json" -not -path "*/node_modules/*" -not -path "*/.tessl/*" 2>/dev/null | head -10
```

If the user provides a path inside a `.tessl/tiles/` directory (an installed tile cache), stop and warn them: that path is Tessl's local install cache — running evals from there won't work and changes would be overwritten on the next `tessl install`. Offer two options: point to the original tile source, or copy the tile out of `.tessl/tiles/` to a new location (`cp -r .tessl/tiles/<workspace>/<tile> ./<tile>`).

If multiple tiles are found outside `.tessl/`, ask the user which one to evaluate. If none are found, explain that this skill evaluates a packaged tile and suggest `tessl tile new` to get started.

### 1.2 Verify eval scenarios exist

```bash
ls <tile-dir>/evals/*/task.md 2>/dev/null
```

If no scenarios exist, inform the user and provide the quickest path to generate them:
```bash
tessl scenario generate <path/to/tile> --count=3
tessl scenario download --last
mv ./evals/ <tile-dir>/evals/
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

Run one eval per model, in sequence from the tile's directory. Do NOT run them in parallel — capture each run ID before starting the next.

```bash
tessl eval run <path/to/tile> --agent=claude:<model> [--runs=<n>]
```

Capture the **eval run ID** from the output (`Eval run started: <id>`). Store all run IDs mapped to model names. After each starts, briefly update the user (e.g., "✔ Started haiku: `<id>`. Starting sonnet…").

After all are started, share the browser monitoring URLs and note that you'll poll for completion:
```
https://tessl.io/eval-runs/<id>
```

---

## Phase 4: Poll for completion

Poll with `tessl eval view <id>` every few minutes, checking for `Status: ✔ Completed` or `Status: ✖ Failed`.

Report status as runs complete (e.g., haiku ✔, sonnet → In Progress, opus → In Progress).

If a run fails, retry immediately:
```bash
tessl eval retry <id>
```

Wait until all runs show `Completed` before proceeding.

---

## Phase 5: Collect and compare results

Fetch full results for each run:
```bash
tessl eval view <id> --json
```

Parse both the **baseline (without skill)** and **with skill** scores for every scenario and criterion.

### 5.1 Overall summary table

```
Model Comparison — <tile-name>

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

Assess what baseline (without-skill) scores reveal before discussing the skill's impact:

- **High baseline (≥ 80%):** The base model handles this task on its own — the skill adds little value here.
- **Low baseline (< 50%):** The base model struggles without guidance — this is where the skill earns its place.
- **Variable baseline across models:** If haiku struggles but sonnet/opus don't, haiku users benefit more from the skill.

### 6.2 Classify failing criteria

For criteria that score poorly (with skill):

- **"Universal Failure" pattern (all models fail):** Tile gap — instructions are missing, ambiguous, or conflicting. Highest priority.
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
tessl tile publish <path/to/tile>
```

**If results are variable / runs=1 was used:** Recommend re-running with `--runs=3` before publishing to average out variance.

**Always offer:** "Want me to re-run the comparison after any fixes to verify improvement?"

---

## When to stop

Stop when:
- The comparison tables, per-scenario breakdown, and diagnosis have been presented
- The user has a clear picture of which scenarios/criteria need attention and for which models
- The user has decided on next steps (fix → re-run, or proceed to publish)

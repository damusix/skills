---
name: optimize-skill-performance
description: Run task evals, analyze results, diagnose failures, apply targeted fixes, and re-run to verify improvements. Use when debugging evaluation scores, fixing failing or regressed criteria, analyzing why eval criteria pass or fail, reviewing eval rubric quality and redundant criteria, tracking before/after score improvements, editing plugin content to fix specific failing behaviors, or improving agent performance based on eval evidence.
---

# Review Task Performance

You are an agent that runs task evals and automates the improvement cycle for Tessl plugins. The user has a plugin with eval results and wants to improve their scores. You handle the analysis, diagnosis, fixes, and re-run cycle.

**Companion skill:** If the user has no scenarios yet, point them to the `setup-skill-performance` skill which handles scenario generation.

**Time expectations:** Each re-run takes ~10–15 minutes per scenario per agent (each scenario runs baseline + with-context). Budget accordingly — if you have 3 scenarios, expect ~30–45 minutes per iteration.

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

## Phase 0: Detect Starting Point

Before diving into analysis, determine what state the user is in.

### 0.1 Decide which eval types the user needs

Rather than routing to a single path (activation OR scored), reason about which combination fits the user's goal:

- **Multi-skill plugin, no evals yet** → run activation first, then scored evals only where routing is clean. This avoids wasting scored-eval time on scenarios that route to the wrong skill.
- **Multi-skill plugin, user wants the full picture fast** → run both activation and scored evals in parallel (two `tessl eval run` commands).
- **Multi-skill plugin, scored evals already exist** → run activation to check routing, then cross-reference with existing scored results.

To determine the plugin's skill count:
```bash
ls skills/*/SKILL.md 2>/dev/null | wc -l
```

To check for existing eval results:
```bash
tessl eval view --last --json 2>&1
```

**If results exist**, check whether the run skipped forced context activation:

```bash
tessl eval view --last --json | jq '.data.attributes.skipForcedContextActivation'
```

- `false` or field absent → proceed to Phase 1 (score-based analysis). If multi-skill, suggest also running activation to check routing.
- `true` → proceed to Phase 0.4 (activation analysis). Recommend a scored eval run next for scenarios where routing is clean.

### 0.2 If no results, check for scenarios on disk

Look for an `evals/` directory:
```bash
ls evals/*/task.md 2>/dev/null
```

**If scenarios exist on disk but no eval results** → before running, quickly check whether the scenarios are missing fixtures or setup scripts the plugin clearly needs. Apply the signals from [setup-skill-performance/references/phase3-fixtures-and-setup.md](../setup-skill-performance/references/phase3-fixtures-and-setup.md) §"Detection rules" to each scenario's `task.md` + `criteria.json` + the plugin's `SKILL.md`.

If any scenario fires a signal but has no `fixtures` (or no `setup` / `setup.sh` when warranted), warn the user:

> "Scenario `<slug>` looks like it needs a [fixture / setup script] but `scenario.json` doesn't declare one. Running the eval as-is will start in an empty workdir and likely fail. Want to jump back to `setup-skill-performance` Phase 3 to generate it, or run anyway?"

If they choose to generate, hand off to that procedure. If they choose to run anyway, proceed.

Then tell the user:

> "I found scenarios on disk but no eval results yet. Want me to run evals now?"
>
> If yes, run:
> ```bash
> tessl eval run <path/to/plugin> --label <run-label>
> ```
>
> Then poll for completion (see Phase 4.4) and proceed to Phase 1.

### 0.3 If no scenarios exist

Tell the user no scenarios were found and offer to invoke `setup-skill-performance` (which generates scenarios, downloads them, and runs baseline + with-context evals).

### 0.4 Activation results detected

The last eval used `--skip-forced-context-activation --skip-scoring`. This shows which skills fired per scenario — there are no baseline or with-context scores, so bucket classification does not apply.

1. **Skill coverage summary**: Report which skills in the plugin never fired across any scenario (see phase5-view-results.md §5.1b "Skill coverage summary").

2. **Zero-activation analysis**: For each scenario showing `–` (no skill activated), check if a score-based eval exists for the same scenario and use the delta to determine if it's a routing gap or an out-of-scope task (see phase5-view-results.md §5.1b "Zero-activation analysis").

3. **Auto-suggest description rewrites**: For any routing gap identified, read the skill's description and the scenario's task phrasing, then propose a minimal description edit (see phase5-view-results.md §5.1b "Auto-suggested description rewrites"). Apply approved rewrites before proceeding.

To continue with score-based optimization, run a full eval:
```bash
tessl eval run <path/to/plugin> --agent=claude:claude-sonnet-4-6 --label <run-label>
```
Then return to Phase 0.1 once complete.

---

## Phase 1: Analyze Results

> This phase applies to **scored runs only**. If the last eval used `--skip-forced-context-activation --skip-scoring`, go back to Phase 0.4.

### 1.1 Get the latest eval results

```bash
tessl eval view --last --json
```

The `eval view` gives you the detailed per-criterion scores.

Parse the JSON output. For each scenario, extract:
- Scenario name
- Each criterion's name, max score, baseline score, and with-context score
- The aggregate baseline → with-context delta for each scenario

### 1.2 Classify every criterion into one of four buckets

**Bucket A — Working well (no action needed)**
- With-context score is >= 80% of max AND significantly higher than baseline
- These are your plugin's strengths. Leave them alone.

**Bucket B — Plugin gap (needs a fix)**
- With-context score is < 80% of max AND baseline is also low
- The agent doesn't know this without your help, and your plugin isn't teaching it well enough yet.
- This is where fixes have the highest impact.

**Bucket C — Redundant (consider removing)**
- Baseline score is already >= 80% of max without any plugin context
- The agent already knows this. Your plugin isn't adding value for this criterion.
- Flag these to the user — the criterion may be unnecessary, or the task is too easy.

**Bucket D — Regression (needs investigation)**
- With-context score is LOWER than baseline
- Your plugin is actively confusing the agent on this point. This is the highest priority to fix.

### 1.3 Present the analysis

Show the user a summary table:

```
Eval Analysis for: <plugin-name>

Scenario: <name> (baseline: XX% -> with-plugin: YY%)

  Bucket B — Plugin Gaps (fix these):
    - "Exponential backoff" — 0/9 (baseline also 0/9)
      Diagnosis: Plugin never mentions backoff timing pattern
      File to fix: skills/onboard/SKILL.md
      Suggested fix: Add "retry with exponential backoff: 1s, 2s, 4s" to Step 1

  Bucket D — Regressions (investigate):
    - "Auth URL capture" — 4/8 (baseline was 6/8)
      Diagnosis: Recent edit may have muddied the auth instructions
      Files to check: skills/onboard/SKILL.md, rules/onboarding-guide.md

  Bucket C — Redundant:
    - "Step-by-step structure" — baseline 10/10, plugin 10/10
      Note: Agents already do this naturally. Consider removing this criterion.

  Bucket A — Working well (5 criteria): [collapsed]
```

Ask the user: **"Want me to fix the Bucket B and D items? I'll show you each change before committing."**

---

## Phase 2: Diagnose Root Causes

For each Bucket B and Bucket D criterion:

### 2.1 Read the criterion details

Open the scenario's `criteria.json` to understand exactly what the rubric checks for.

### 2.2 Read the relevant plugin files

Read:
- `skills/*/SKILL.md` — skill instructions
- `rules/*.md` — rules loaded into agent context
- `docs/*.md` — reference documentation

### 2.3 Find the gap

For each failing criterion, determine:
- **What the rubric wants**: The specific behavior or content the judge is looking for
- **What the plugin says**: What guidance the plugin files currently provide (or don't)
- **The gap**: What's missing, vague, or contradictory

### 2.4 Check for contradictions

Scan across ALL plugin files for statements that contradict each other. Common patterns:
- Skill says "retry 3 times" but rules say "retry with backoff" without specifying count
- Docs describe a different flow order than the skill's steps
- Rules say something is optional but the skill treats it as required

Flag any contradictions to the user even if they aren't related to failing criteria — they can cause future regressions.

---

## Phase 3: Apply Fixes

For each fix, follow this sequence:

### 3.1 Propose the change

Show the user:
- Which file you'll edit
- What you'll add/change (the actual text)
- Why this should improve the specific criterion

### 3.2 Apply the edit

Make the change to the file. Keep edits minimal and targeted — don't rewrite sections that are already working.

**Rules for good fixes:**
- Be explicit. If the criterion wants "exponential backoff: 1s, 2s, 4s", write exactly that. Don't write "use appropriate backoff."
- Match the rubric's language. If `criteria.json` checks for the phrase "safe and reversible", use those exact words in your plugin.
- Don't bloat the plugin. Add the minimum needed. Every token of context costs attention.
- Preserve what works. Don't restructure sections that score well in Bucket A.

### 3.3 Lint after each fix

```bash
tessl plugin lint <plugin-path>
```

Check that the plugin is still valid and token costs haven't ballooned. If front-loaded tokens increased significantly, consider moving content to docs (on-demand) instead of rules (always loaded).

### 3.4 Handle Bucket C (redundant criteria)

For criteria where baseline is already high, ask the user:

> "The criterion '<name>' scores <X>% even without your plugin. Options:
> 1. Remove it from criteria.json (agents already know this)
> 2. Make the task harder so it actually tests your plugin's value
> 3. Keep it as a sanity check
>
> What do you prefer?"

If the user chooses to remove, edit the scenario's `criteria.json` and redistribute the weight to remaining criteria.

### 3.5 Handle Bucket D (regressions)

For regressions, the fix often isn't adding content — it's clarifying or removing content that confused the agent. Check for:
- Ambiguous instructions that could be interpreted multiple ways
- Contradictory statements between files
- Overly verbose sections where the key point gets buried
- Recent additions that conflict with existing guidance

Show the user the contradiction or ambiguity, then propose a clarification.

---

## Phase 4: Re-run and Verify

### 4.1 Summarize all changes

Before committing, show the user a summary:

```
Changes made:
  1. skills/onboard/SKILL.md — Added exponential backoff timing (1s, 2s, 4s) to Step 1
  2. rules/onboarding-guide.md — Clarified that repo eval is always optional
  3. evals/error-recovery/criteria.json — Removed redundant "network retry" criterion

Expected impact:
  - "Exponential backoff" should go from 0/9 -> 9/9
  - "Repo eval is optional" should go from 0/8 -> 8/8
  - Regression on "Auth URL capture" should resolve (removed contradictory instruction)

Commit and re-run evals?
```

### 4.2 Commit (with user approval)

```bash
git add <files-you-changed>
git commit -m "Improve plugin: <brief description of fixes>"
```

Only stage the files you actually changed. Don't stage unrelated files.

### 4.3 Re-run evals

```bash
tessl eval run <path/to/plugin> --label <run-label>
```

If the eval doesn't pick up your changes, make sure you've committed them first.

### 4.4 Poll for completion

```bash
tessl eval list --mine --limit 1
```

Wait until status shows completed. If status shows `failed`, run `tessl eval retry <id>`.

Otherwise, get results:

```bash
tessl eval view --last
```

### 4.5 Report the before/after

Show the user:

```
Before -> After:

  CLI setup automation:        87% -> 96%  (+9)
  Skill scaffolding:           88% -> 88%  (no change)
  Output file generation:     100% -> 100% (no change)
  Error recovery:              91% -> 99%  (+8)
  User interaction:           100% -> 100% (no change)

  Average:                     93% -> 97%  (+4)

Remaining gaps:
  - "Exponential backoff" still at 0/9 — may need a different approach
```

If gaps remain, ask: **"Want me to take another pass at the remaining gaps?"**

---

## Phase 5: Scenario Quality Review (Bonus)

If the user asks, or if you notice issues during Phase 2, review the scenarios themselves:

### 5.1 Check task realism

Read each `task.md` and flag:
- Tasks that are unrealistically specific (testing memorization, not understanding)
- Tasks that are too vague to produce consistent results
- Tasks that don't match real-world use cases for this plugin

### 5.2 Check criteria quality

Read each `criteria.json` and flag:
- Criteria with equal weights (should important ones weigh more?)
- Criteria that are too strict (exact string matching when intent matching would be better)
- Missing criteria for important behaviors the plugin teaches
- Criteria that test the agent's general ability, not the plugin's value

### 5.3 Suggest improvements

Propose specific edits to `task.md` or `criteria.json` files. Show diffs and explain why.

---

## When to stop

Stop iterating when:
- All with-context scores are >= 85% and no regressions exist
- Remaining low scores are on criteria the user has reviewed and accepted
- The user says they're satisfied
- Further improvements would require restructuring the plugin significantly (suggest this as a separate effort)

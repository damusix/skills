---
name: optimize-skill-performance
description: Run task evals, analyze results, diagnose failures, apply targeted fixes, and re-run to verify improvements. Use when debugging evaluation scores, fixing failing or regressed criteria, improving tile content after an eval run, or iterating on agent performance test results.
---

# Review Task Performance

You are an agent that runs task evals and automates the improvement cycle for Tessl tiles. The user has a tile with eval results and wants to improve their scores. You handle the analysis, diagnosis, fixes, and re-run cycle.

**Companion skill:** If the user has no scenarios yet, point them to the `setup-skill-performance` skill which handles scenario generation.

**Time expectations:** Each re-run takes ~10–15 minutes per scenario per agent (each scenario runs baseline + with-context). Budget accordingly — if you have 3 scenarios, expect ~30–45 minutes per iteration.

---

## Phase 0: Detect Starting Point

Before diving into analysis, determine what state the user is in.

### 0.1 Check for existing eval results

Run:
```bash
tessl eval view --last --json 2>&1
```

**If results exist** → proceed to Phase 1.

### 0.2 If no results, check for scenarios on disk

Look for an `evals/` directory:
```bash
ls evals/*/task.md 2>/dev/null
```

**If scenarios exist on disk but no eval results** → tell the user:

> "I found scenarios on disk but no eval results yet. Want me to run evals now?"
>
> If yes, run:
> ```bash
> tessl eval run <path/to/tile>
> ```
>
> This will take ~10–15 minutes per scenario. Then poll for completion (see Phase 4.4) and proceed to Phase 1.

### 0.3 If no scenarios exist

Tell the user:

> "No eval scenarios found. To use optimize-skill-performance, you first need scenarios to evaluate against. You can set these up with the `setup-skill-performance` skill, which will:
> 1. Generate eval scenarios from your tile
> 2. Download them to disk
> 3. Run baseline + with-context evals
>
> Want to run setup-skill-performance first?"

---

## Phase 1: Analyze Results

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
- These are your tile's strengths. Leave them alone.

**Bucket B — Tile gap (needs a fix)**
- With-context score is < 80% of max AND baseline is also low
- The agent doesn't know this without your help, and your tile isn't teaching it well enough yet.
- This is where fixes have the highest impact.

**Bucket C — Redundant (consider removing)**
- Baseline score is already >= 80% of max without any tile context
- The agent already knows this. Your tile isn't adding value for this criterion.
- Flag these to the user — the criterion may be unnecessary, or the task is too easy.

**Bucket D — Regression (needs investigation)**
- With-context score is LOWER than baseline
- Your tile is actively confusing the agent on this point. This is the highest priority to fix.

### 1.3 Present the analysis

Show the user a summary table:

```
Eval Analysis for: <tile-name>

Scenario: <name> (baseline: XX% -> with-tile: YY%)

  Bucket B — Tile Gaps (fix these):
    - "Exponential backoff" — 0/9 (baseline also 0/9)
      Diagnosis: Tile never mentions backoff timing pattern
      File to fix: skills/onboard/SKILL.md
      Suggested fix: Add "retry with exponential backoff: 1s, 2s, 4s" to Step 1

  Bucket D — Regressions (investigate):
    - "Auth URL capture" — 4/8 (baseline was 6/8)
      Diagnosis: Recent edit may have muddied the auth instructions
      Files to check: skills/onboard/SKILL.md, rules/onboarding-guide.md

  Bucket C — Redundant:
    - "Step-by-step structure" — baseline 10/10, tile 10/10
      Note: Agents already do this naturally. Consider removing this criterion.

  Bucket A — Working well (5 criteria): [collapsed]
```

Ask the user: **"Want me to fix the Bucket B and D items? I'll show you each change before committing."**

---

## Phase 2: Diagnose Root Causes

For each Bucket B and Bucket D criterion:

### 2.1 Read the criterion details

Open the scenario's `criteria.json` to understand exactly what the rubric checks for.

### 2.2 Read the relevant tile files

Read:
- `skills/*/SKILL.md` — skill instructions
- `rules/*.md` — rules loaded into agent context
- `docs/*.md` — reference documentation

### 2.3 Find the gap

For each failing criterion, determine:
- **What the rubric wants**: The specific behavior or content the judge is looking for
- **What the tile says**: What guidance the tile files currently provide (or don't)
- **The gap**: What's missing, vague, or contradictory

### 2.4 Check for contradictions

Scan across ALL tile files for statements that contradict each other. Common patterns:
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
- Match the rubric's language. If `criteria.json` checks for the phrase "safe and reversible", use those exact words in your tile.
- Don't bloat the tile. Add the minimum needed. Every token of context costs attention.
- Preserve what works. Don't restructure sections that score well in Bucket A.

### 3.3 Lint after each fix

```bash
tessl tile lint <tile-path>
```

Check that the tile is still valid and token costs haven't ballooned. If front-loaded tokens increased significantly, consider moving content to docs (on-demand) instead of rules (always loaded).

### 3.4 Handle Bucket C (redundant criteria)

For criteria where baseline is already high, ask the user:

> "The criterion '<name>' scores <X>% even without your tile. Options:
> 1. Remove it from criteria.json (agents already know this)
> 2. Make the task harder so it actually tests your tile's value
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

Commit and re-run evals? (Note: re-run will take ~10–15 minutes per scenario)
```

### 4.2 Commit (with user approval)

```bash
git add <files-you-changed>
git commit -m "Improve tile: <brief description of fixes>"
```

Only stage the files you actually changed. Don't stage unrelated files.

### 4.3 Re-run evals

```bash
tessl eval run <path/to/tile>
```

If the eval doesn't pick up your changes, make sure you've committed them first.

### 4.4 Poll for completion

```bash
tessl eval list --mine --limit 1
```

Wait until status shows completed. With N scenarios, expect ~N × 10–15 minutes. Then get results:

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
- Tasks that don't match real-world use cases for this tile

### 5.2 Check criteria quality

Read each `criteria.json` and flag:
- Criteria with equal weights (should important ones weigh more?)
- Criteria that are too strict (exact string matching when intent matching would be better)
- Missing criteria for important behaviors the tile teaches
- Criteria that test the agent's general ability, not the tile's value

### 5.3 Suggest improvements

Propose specific edits to `task.md` or `criteria.json` files. Show diffs and explain why.

---

## When to stop

Stop iterating when:
- All with-context scores are >= 85% and no regressions exist
- Remaining low scores are on criteria the user has reviewed and accepted
- The user says they're satisfied
- Further improvements would require restructuring the tile significantly (suggest this as a separate effort)

---
name: optimize-skill-performance-and-instructions
description: Run the full optimization cycle for a plugin — review best practices, generate eval scenarios, run BOTH activation evals (does the skill self-activate?) and content evals (does the plugin help solve tasks?), diagnose gaps, fix, and re-run until scores improve. Use when someone says "optimize my skill", "improve my plugin", "run evals", "benchmark my plugin", or wants to measure and improve how well a plugin helps agents solve tasks.
---

# Optimize

This skill orchestrates **optimize-skill-instructions**, **setup-skill-performance**, and **optimize-skill-performance** into a single end-to-end optimization cycle.

The full cycle takes 1–2 hours depending on how many scenarios and improvement iterations are needed. Set this expectation with the user upfront.

## Overview

```
Review SKILL.md → Apply quick wins → Generate scenarios → Activation check → Content evals → Analyze → Fix → Re-run → Report
└── optimize-skill-instructions ──┘  └─────────── setup-skill-performance ───────────┘  └──────────── optimize-skill-performance ────────────┘
```

Two distinct eval types run in this cycle:
- **Activation eval** — observes which skill self-activates per scenario (does NOT force activation). Tests routing/description quality. ~2–3 min.
- **Content eval** — forces activation, runs baseline vs. with-context, scores the rubric. Tests content quality. ~10–15 min per scenario per agent.

Both apply to every plugin (single-skill and multi-skill alike). The variable is *ordering*, not whether to run them.

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

## Key commands

```bash
tessl skill review skills/<name>/SKILL.md     # review a skill (Step 1)
tessl scenario generate <plugin-path> --count=5 # generate scenarios (Step 2)
tessl eval run <plugin-path> --skip-forced-context-activation --skip-scoring --label <run-label> # test skill routing
tessl eval run <plugin-path> --agent=claude:claude-sonnet-4-6 --label <run-label> # scored eval
tessl eval view --last --json                 # check results
```

## Step 1: Review best practices

Invoke the **optimize-skill-instructions** skill. This runs `tessl skill review` on the plugin's skill(s), surfaces scoring dimensions and quick wins, and applies approved changes.

**Entry criteria:** The plugin has at least one `SKILL.md`.

**Exit criteria:** Review score is presented, approved quick wins are applied. Move to Step 2.

If the review score is already high (>= 85%) and the user is satisfied, skip to Step 2 without changes.

## Step 2: Run setup-skill-performance (full pipeline scope)

Invoke the **setup-skill-performance** skill with scope = "Full pipeline". Skip the scope question — go straight to Phase 1.

**Before invoking, decide eval ordering by skill count:**

```bash
ls skills/*/SKILL.md 2>/dev/null | wc -l
```

- **Multi-skill plugin (count > 1):** run Phase 4a (activation) BEFORE Phase 4b (content). Routing problems surface fast and prevent wasted content-eval time on misrouted scenarios.
- **Single-skill plugin (count == 1):** run 4a and 4b in parallel, or 4a first if you prefer serial. A bad description means the skill never fires regardless of skill count, so 4a is required either way.

Work through all phases of setup-skill-performance (Find Plugin → Generate Scenarios → Download & QC → Activation Check → Content Evals → View Results → Next Steps). Key parameters:
- Generate 3–5 scenarios from the plugin
- Quality-check downloaded criteria for anti-patterns before running
- Default agent: `claude:claude-sonnet-4-6`

**Decision point after results:** If the activation check has been run and reviewed AND the content eval average is ≥ 85% with no regressions, stop and report success. Otherwise, continue to Step 3.

## Step 3: Classify and prioritize

Before invoking optimize-skill-performance, do a quick triage of the results:

- **If baseline is ≥ 80% on most scenarios**: The scenarios may be too easy. Consider regenerating harder scenarios before trying to improve the plugin.
- **If regressions exist** (with-context < baseline): These are highest priority — the plugin is actively hurting.
- **If with-context has room to grow**: Proceed to optimize-skill-performance.

## Step 4: Run optimize-skill-performance

Invoke the **optimize-skill-performance** skill starting from Phase 1 (it will detect the existing results).

Work through the improve cycle:
1. Analyze results — classify every criterion into buckets (working / gap / redundant / regression)
2. Diagnose root causes by reading the failing criteria and the plugin files
3. Apply targeted, minimal fixes to the appropriate files
4. Re-run evals
5. Compare before/after

**Iteration rule:** Run up to 2 improve iterations. After the second, report results and stop — the user should review before investing more time.

## Step 5: Report

Present a final summary. Activation and content results are reported separately because they measure different things — activation observes natural firing, content forces activation and scores task performance.

```
Optimization Complete

  Plugin:         <plugin-name>
  Review score: XX% → YY%
  Scenarios:    N scenarios
  Iterations:   X (1 setup + Y improve rounds)

  Activation Results (natural activation, no forcing)
    Scenarios where a skill fired:
      - Scenario A → fired: skills/<name>
      - Scenario C → fired: skills/<name>
    Scenarios where NO skill fired:
      - Scenario B
      - Scenario D

  Task Eval Results (forced activation)
    Scenario A:  baseline XX% → with-context YY%  (Δ +ZZ)
    Scenario B:  baseline XX% → with-context YY%  (Δ +ZZ)
    ...
    Average:     XX% → YY%

  Cross-reference (where the two eval types meet)
    No-activation but high baseline (no skill needed — routing is fine):
      - Scenario B (88% baseline) — agent already handles it
    No-activation AND low baseline (real routing gap — skill helps but doesn't fire):
      - Scenario D (25% baseline → 90% with-context) — suggested description edit: …

  Criteria improved:  [list]
  Still failing:      [list with brief reason]

  Eval runs:
    Activation: [URL]
    Content:    [URL]
```

If criteria remain stuck after 2 iterations, note whether the gap is addressable via documentation (suggest specific follow-up) or is inherently hard for the agent (suggest accepting or replacing the scenario).

## When to stop

Stop when:
- Review score is high AND the activation check has been run and reviewed with the user AND content eval average ≥ 85% with no regressions
- 2 improve iterations have been completed
- The user says they're satisfied
- Further improvements would require restructuring the plugin significantly (suggest this as a separate effort)

Note: activation findings (zero-firing skills, scenarios with no activation) drive *follow-up actions* (description rewrites, scenario edits) but are not a numeric pass/fail gate. The gate is "ran and reviewed", not a coverage percentage — natural activation is scenario-driven, so "X of Y skills fired" is not a useful score.

---
name: optimize-skill-performance-and-instructions
description: Run the full optimization cycle for a tile — review best practices, generate eval scenarios, run evals, diagnose gaps, fix, and re-run until scores improve. Use when someone says "optimize my skill", "improve my tile", "run evals", "benchmark my tile", or wants to measure and improve how well a tile helps agents solve tasks.
---

# Optimize

This skill orchestrates **optimize-skill-instructions**, **setup-skill-performance**, and **optimize-skill-performance** into a single end-to-end optimization cycle. Rather than duplicating their instructions, it sequences them and handles the handoff.

The full cycle takes 1–2 hours depending on how many scenarios and improvement iterations are needed. Set this expectation with the user upfront.

## Overview

```
Review SKILL.md → Apply quick wins → Generate scenarios → Run evals → Analyze → Fix → Re-run → Report
└── optimize-skill-instructions ──┘  └── setup-skill-performance ──┘  └────────── optimize-skill-performance ──────────────┘
```

## Step 1: Review best practices

Invoke the **optimize-skill-instructions** skill. This runs `tessl skill review` on the tile's skill(s), surfaces scoring dimensions and quick wins, and applies approved changes.

**Entry criteria:** The tile has at least one `SKILL.md`.

**Exit criteria:** Review score is presented, approved quick wins are applied. Move to Step 2.

If the review score is already high (>= 85%) and the user is satisfied, skip to Step 2 without changes.

## Step 2: Run setup-skill-performance (full pipeline scope)

Invoke the **setup-skill-performance** skill with scope = "Full pipeline". Skip the scope question — go straight to Phase 1.

Work through all phases of setup-skill-performance (Find Tile → Generate Scenarios → Download & QC → Run Evals → View Results → Next Steps). Key parameters:
- Generate 3–5 scenarios from the tile
- Quality-check downloaded criteria for anti-patterns before running
- Default agent: `claude:claude-sonnet-4-6`

**Decision point after results:** If the average eval score is already ≥ 85% with no regressions, stop and report success. Otherwise, continue to Step 3.

## Step 3: Classify and prioritize

Before invoking optimize-skill-performance, do a quick triage of the results:

- **If baseline is ≥ 80% on most scenarios**: The scenarios may be too easy. Consider regenerating harder scenarios before trying to improve the tile.
- **If regressions exist** (with-context < baseline): These are highest priority — the tile is actively hurting.
- **If with-context has room to grow**: Proceed to optimize-skill-performance.

## Step 4: Run optimize-skill-performance

Invoke the **optimize-skill-performance** skill starting from Phase 1 (it will detect the existing results).

Work through the improve cycle:
1. Analyze results — classify every criterion into buckets (working / gap / redundant / regression)
2. Diagnose root causes by reading the failing criteria and the tile files
3. Apply targeted, minimal fixes to the appropriate files
4. Re-run evals
5. Compare before/after

**Iteration rule:** Run up to 2 improve iterations. After the second, report results and stop — diminishing returns set in quickly, and the user should review before investing more time.

## Step 5: Report

Present a final summary:

```
Optimization Complete

  Tile:         <tile-name>
  Review score: XX% → YY%
  Scenarios:    N scenarios
  Iterations:   X (1 setup + Y improve rounds)

  Eval before (baseline):     XX%
  Eval after (with tile):     YY%  (Δ +ZZpp)

  Criteria improved:  [list]
  Still failing:      [list with brief reason]

  Eval run: [URL to latest run]
```

If criteria remain stuck after 2 iterations, note whether the gap is addressable via documentation (suggest specific follow-up) or is inherently hard for the agent (suggest accepting or replacing the scenario).

## When to stop

Stop when:
- Review score is high AND eval average ≥ 85% with no regressions
- 2 improve iterations have been completed
- The user says they're satisfied
- Further improvements would require restructuring the tile significantly (suggest this as a separate effort)

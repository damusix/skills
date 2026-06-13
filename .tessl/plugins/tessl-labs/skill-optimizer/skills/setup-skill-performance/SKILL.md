---
name: setup-skill-performance
description: Generate eval scenarios from a tile, run baseline evals, and present results. Use when setting up evaluation pipelines, running benchmarks, generating test scenarios for a tile, or measuring how well a skill helps agents solve tasks.
---

# Eval Setup

You handle tile eval setup — scenario generation from a tile, running evals, and presenting results.

The user triggers this skill when they have a tile but no eval scenarios yet, or when they want to generate new scenarios.

**Companion skill:** After setup is complete, suggest the user run the `optimize-skill-performance` skill to analyze results, diagnose failures, fix tile content, and re-verify improvements.

**Time expectations:** Set these upfront so the user isn't surprised:
- Scenario generation: ~1–2 minutes per scenario
- Eval run: ~10–15 minutes per scenario per agent (each scenario runs twice: baseline + with-context)
- For a first run, aim for 3–5 scenarios with 1 agent to keep total time under 2 hours

---

## Choose scope

Before diving in, figure out what the user wants to accomplish in this session. If the user's request already makes the scope clear (e.g., "run my evals", "generate scenarios"), skip the question and go straight to the relevant phase.

Otherwise, ask:

> "What would you like to do?
>
> 1. **Full pipeline** — generate scenarios, run evals, and see results (start-to-finish, ~1 hour)
> 2. **Generate scenarios only** — generate and download scenarios, but don't run evals yet
> 3. **Run evals on existing scenarios** — skip generation, just run and compare results on scenarios already in `evals/`
> 4. **Something else** — tell me what you need"

Map the user's choice to phases:

| Choice | Phases to run |
|--------|--------------|
| Full pipeline | 1 → 2 → 3 → 4 → 5 → 6 |
| Generate scenarios only | 1 → 2 → 3 |
| Run evals on existing scenarios | 1 → 4 → 5 → 6 |

For partial runs, skip phases not in scope — don't load their reference files.

---

## Phase 1: Find the Tile

Locate the tile and check for existing scenarios.

Read [references/phase1-gather-context.md](references/phase1-gather-context.md) for the full procedure.

---

## Phase 2: Generate Scenarios

Run `tessl scenario generate` against the tile and review what was generated.

Read [references/phase2-generate-scenarios.md](references/phase2-generate-scenarios.md) for the full procedure.

---

## Phase 3: Download Scenarios

Download scenarios to `evals/`, verify the structure, and quality-check for rubric anti-patterns (answer leakage, double-counting, free points) before proceeding.

Read [references/phase3-download-scenarios.md](references/phase3-download-scenarios.md) for the full procedure.

---

## Phase 4: Configure and Run Evals

Choose agents/models, run `tessl eval run`, and poll for completion.

Read [references/phase4-run-evals.md](references/phase4-run-evals.md) for the full procedure.

---

## Phase 5: View Results

Show baseline vs. with-context scores and per-scenario breakdown.

Read [references/phase5-view-results.md](references/phase5-view-results.md) for the full procedure.

---

## Phase 6: Recommend Next Steps

Summarize the setup, suggest next actions based on scores, and offer to continue.

Read [references/phase6-next-steps.md](references/phase6-next-steps.md) for the full procedure.

---

## When to stop

Stop when:
- The user has completed their chosen scope (see "Choose scope" above)
- The user has seen any applicable results
- The user decides whether to proceed to `optimize-skill-performance` or stop

---
name: setup-skill-performance
description: Generate eval scenarios from a Tessl plugin (a packaged skill bundle), run baseline + with-context evals, and present results. Use when setting up an evaluation pipeline, running benchmarks, generating test scenarios, measuring skill performance or accuracy, scoring how well a skill helps agents solve tasks, or evaluating skill effectiveness before publishing.
---

# Eval Setup

You handle plugin eval setup — scenario generation from a plugin, running evals, and presenting results.

The user triggers this skill when they have a plugin but no eval scenarios yet, or when they want to generate new scenarios.

**Companion skill:** After setup is complete, suggest the user run the `optimize-skill-performance` skill to analyze results, diagnose failures, fix plugin content, and re-verify improvements.

**Time expectations:** Set these upfront so the user isn't surprised:
- Scenario generation: ~1–2 minutes per scenario
- Eval run: ~10–15 minutes per scenario per agent (each scenario runs twice: baseline + with-context)
- For a first run, aim for 3–5 scenarios with 1 agent to keep total time under 2 hours

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
| Full pipeline | 1 → 2 → 3 → 4a → 4b → 5 → 6 |
| Generate scenarios only | 1 → 2 → 3 |
| Run evals on existing scenarios | 1 → 4a → 4b → 5 → 6 |

For partial runs, skip phases not in scope — don't load their reference files.

---

## Phase 1: Find the Plugin

Locate the plugin and check for existing scenarios.

Read [references/phase1-gather-context.md](references/phase1-gather-context.md) for the full procedure.

---

## Phase 2: Generate Scenarios

Run `tessl scenario generate` against the plugin and review what was generated.

Read [references/phase2-generate-scenarios.md](references/phase2-generate-scenarios.md) for the full procedure.

---

## Phase 3: Download Scenarios

Download scenarios to `evals/`, verify the structure, quality-check for rubric anti-patterns (answer leakage, double-counting, free points), and detect when scenarios need fixtures or setup scripts before proceeding.

Read [references/phase3-download-scenarios.md](references/phase3-download-scenarios.md) for the full procedure. The fixture / setup-script detection step (§3.4) loads [references/phase3-fixtures-and-setup.md](references/phase3-fixtures-and-setup.md) — that file owns the signals, skip rules, sourcing procedure, and pre-run summary format.

---

## Phase 4a: Activation Check

Run the activation eval (`--skip-forced-context-activation --skip-scoring`) to observe which skill self-activates per scenario. Activation does NOT force a skill to fire — it tests routing/description quality. Applies to **all plugins**, single-skill and multi-skill alike: a single-skill plugin with a bad description still won't fire, so this check is required regardless of skill count.

**Ordering:**
- Multi-skill plugin: run 4a BEFORE 4b — routing problems surface fast and prevent wasted content-eval time on misrouted scenarios.
- Single-skill plugin: 4a and 4b can run in parallel, or 4a first if you prefer serial.

Read [references/phase4-run-evals.md](references/phase4-run-evals.md) §Phase 4a for the full procedure.

---

## Phase 4b: Configure and Run Content (Task) Evals

Choose agents/models, run `tessl eval run` (the default — forces activation and scores), and poll for completion.

Read [references/phase4-run-evals.md](references/phase4-run-evals.md) §Phase 4b for the full procedure.

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

# Phase 5: View Results

## 5.1 View detailed results

```bash
tessl eval view --last
```

Show the user the overall scores and per-scenario breakdown.

Present the key findings:

```
Eval Results Summary:

  Scenario                  Baseline  With-Plugin  Delta
  checkout-flow              42%       87%          +45
  webhook-setup              38%       72%          +34
  error-recovery             65%       91%          +26

  Overall:                   48%       83%          +35

Key observations:
  - checkout-flow: Plugin adds significant value (+45 points)
  - webhook-setup: Good improvement but still below 80% threshold
  - error-recovery: Strong improvement, above 80%
```

## 5.1b Activation eval results

If the eval used `--skip-forced-context-activation --skip-scoring`, present the skill routing table instead of score deltas:

```
Activation Results — <plugin-name>

  Scenario                          Activated skills
  ────────────────────────────────────────────────────────────
  Produce a URL slug                slug-skill
  Slugify a title with umlauts      slug-skill
  Create a filename from a title    filename-skill
  Produce a Markdown anchor         anchor-skill
  Reverse a string                  –
  Publish a new docs page           anchor-skill, filename-skill, slug-skill
```

### Skill coverage summary

After presenting the routing table, report which skills in the plugin **never fired** across any scenario:

```bash
ls skills/*/SKILL.md 2>/dev/null
```

Cross-reference the skill names against the "Activated skills" column. Any skill that appears in the plugin but never appears in the activation results is an untested skill:

```
Skill coverage:

  Skills that fired:         slug-skill, filename-skill, anchor-skill
  Skills that NEVER fired:   review-friction

  ⚠ review-friction was never activated across 6 scenarios.
    Either the scenarios don't cover its use case, or its trigger
    description doesn't match the phrasing of any scenario.
```

This surfaces skills that may need scenario additions or description rewrites.

### Zero-activation analysis

For any scenario showing `–` (no skill activated), cross-reference with existing score-based eval results before drawing conclusions.

**For each `–` scenario:**

1. Check if a score-based eval exists for the same scenario:
```bash
tessl eval list --mine
tessl eval view <id> --json
```

2. If a matching eval exists, look up that scenario's baseline and with-context scores and present the analysis:

```
Zero-activation scenarios:

  ⚠ 'Reverse a string' — no skill fired

  Matching eval found (run: abc123):
    Baseline:     91%
    With-context: 89%
    Delta:        -2

  The agent performs just as well without the skill. This task is likely
  out of scope — the scenario may not be testing the plugin's actual value.
  Consider removing it.

  ─────────────────────────────────────────────────────────────────

  ⚠ 'Generate a slug from a CMS title' — no skill fired

  Matching eval found (run: abc123):
    Baseline:     34%
    With-context: 31%
    Delta:        -3

  The agent struggles both with and without the skill — and the skill
  isn't firing. This is a routing gap: the skill likely covers this task
  but its trigger description doesn't match this phrasing.
```

3. If no matching eval exists for a `–` scenario, tell the user:

> "'[scenario name]' activated no skills and has no score-based eval to reference. Run a full eval to see whether the agent needs the skill for this task before deciding if it's a gap."

### Auto-suggested description rewrites

When a routing gap is detected (scenario should activate a skill but doesn't), read the skill's current `description` field from its SKILL.md frontmatter and the scenario's task phrasing, then propose a rewrite:

1. Read the skill's SKILL.md and extract the `description:` from frontmatter.
2. Read the scenario's `task.md` to understand the phrasing the activation eval saw.
3. Identify the mismatch — typically the description uses different terminology than the task.
4. Propose a minimal description edit that would cover the missed phrasing without losing existing trigger coverage.

```
Routing gap fix — slug-skill

  Scenario that failed to route: 'Generate a slug from a CMS title'

  Current description:
    "Convert text into URL-safe slugs. Use when creating URL paths from titles."

  Suggested description:
    "Convert text into URL-safe slugs. Use when creating URL paths, filenames,
     or identifiers from titles, headings, or CMS content."

  Why: The scenario mentions "CMS title" which the current description
  doesn't cover. Adding "CMS content" and broadening to "headings" improves
  match without over-triggering.
```

Present all suggested rewrites together and ask: **"Want me to apply these description changes?"**

## 5.2 Multi-agent comparison (if applicable)

If multiple agents were tested, show a comparison:

```
Agent Comparison:

  Agent                     Avg Score   Best Scenario          Worst Scenario
  claude:claude-sonnet-4-6   80%       checkout-flow (87%)    webhook-setup (72%)
  cursor:auto                74%       error-recovery (85%)   webhook-setup (58%)

Observations:
  - Claude Sonnet scores highest on average
  - Both agents struggle with webhook-setup — likely a plugin gap
```

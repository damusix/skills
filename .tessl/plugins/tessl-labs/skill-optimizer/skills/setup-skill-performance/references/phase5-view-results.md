# Phase 5: View Results

## 5.1 View detailed results

```bash
tessl eval view --last
```

Show the user the overall scores and per-scenario breakdown.

Present the key findings:

```
Eval Results Summary:

  Scenario                  Baseline  With-Tile  Delta
  checkout-flow              42%       87%       +45
  webhook-setup              38%       72%       +34
  error-recovery             65%       91%       +26

  Overall:                   48%       83%       +35

Key observations:
  - checkout-flow: Tile adds significant value (+45 points)
  - webhook-setup: Good improvement but still below 80% threshold
  - error-recovery: Strong improvement, above 80%
```

## 5.2 Multi-agent comparison (if applicable)

If multiple agents were tested, show a comparison:

```
Agent Comparison:

  Agent                     Avg Score   Best Scenario          Worst Scenario
  claude:claude-sonnet-4-6   80%       checkout-flow (87%)    webhook-setup (72%)
  cursor:auto                74%       error-recovery (85%)   webhook-setup (58%)

Observations:
  - Claude Sonnet scores highest on average
  - Both agents struggle with webhook-setup — likely a tile gap
```

# Phase 6: Recommend Next Steps

## 6.1 Summarize the setup

```
Eval setup complete!

  Tile:        <tile-name>
  Scenarios:   <N> scenarios
  Agents:      <list of agent:model pairs>
  Location:    <tile-dir>/evals/

  Results:
    Baseline average:      XX%
    With-tile average:     YY%
    Delta:                 +ZZ
```

## 6.2 Suggest next actions

Based on the results, recommend (check in this priority order):

- **If baseline is already high (>= 80% on multiple scenarios):** "Warning: Your baseline scores are high, which means agents can solve these tasks without your tile. These scenarios aren't measuring tile value — they're measuring task triviality. Consider regenerating harder scenarios with `--count=N`."
- **If regressions exist:** "Some criteria scored worse with your tile than without. This is highest priority — run `optimize-skill-performance` to diagnose and fix regressions."
- **If scores have room for improvement:** "Your tile is adding value but there's room to improve. Run the `optimize-skill-performance` skill to analyze which criteria need fixes and apply targeted edits."
- **If all scores are high (>= 85%):** "Your tile is performing well! Consider generating more diverse scenarios to make sure it generalizes."

## 6.3 Offer to continue

Ask: **"Want me to run `optimize-skill-performance` now to analyze these results and start the improvement cycle?"**

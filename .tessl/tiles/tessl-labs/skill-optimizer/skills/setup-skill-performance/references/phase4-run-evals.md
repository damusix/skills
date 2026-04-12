# Phase 4: Configure and Run Evals

## 4.1 Choose agents and models

For a first run, recommend keeping it simple:

> "For a first run, I recommend just using `claude:claude-sonnet-4-6` to keep eval time manageable (~10–15 minutes per scenario). Once you've validated the scenarios are good, you can add more agents to compare.
>
> Want to go with the default, or test multiple agents now?
>
> **Available agents:**
>
> | Agent | Models |
> |-------|--------|
> | `claude` | `claude-sonnet-4-6` (default), `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5` |
> | `cursor` | `auto`, `composer-1.5` |
>
> Note: Each additional agent multiplies the eval run time and cost."

Build the `--agent` flags based on their choice. For multi-agent, each agent is a separate `--agent` flag:
```
--agent=claude:claude-sonnet-4-6 --agent=cursor:auto
```

## 4.2 Run the evals

```bash
tessl eval run <tile-path> \
  --agent=<agent1:model1> \
  [--agent=<agent2:model2>]
```

Note the eval run URL from the output and share it with the user so they can optionally watch progress in the browser.

## 4.3 Poll for completion

```bash
tessl eval list --mine --limit 1
```

Eval runs take ~10–15 minutes per scenario per agent. Each scenario runs twice (baseline without context + with-context). Update the user periodically:

> "Evals are running... Status: in_progress. With N scenarios and 1 agent, expect about X–Y minutes total. I'll check again shortly."

Wait until status shows `completed`. If status shows `failed`, run:
```bash
tessl eval retry <id>
```

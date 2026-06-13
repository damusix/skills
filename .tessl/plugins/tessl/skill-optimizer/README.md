# skill-optimizer

Optimize your skills and plugins: review SKILL.md quality, generate eval scenarios, run evals, compare across models, diagnose gaps, and re-run until scores improve.

## Install

```bash
tessl install tessl/skill-optimizer
```

## Concepts

This plugin combines two complementary approaches to improving your skills:

- **Plugin evals** (`tessl eval run`) — measure whether a plugin makes agents better at real tasks. Scenarios are generated from the plugin, an agent solves each task with and without the plugin, and a judge scores outputs against a per-scenario rubric. The delta between baseline and with-plugin scores shows the value-add.
- **Skill reviews** (`tessl skill review`) — assess the quality of a SKILL.md file itself, without executing any tasks. A judge scores the document on fixed dimensions (completeness, actionability, conciseness, robustness) to check whether it's well-structured for routing and agent comprehension.

The `optimize-skill-performance-and-instructions` skill combines both into a single end-to-end cycle: review → eval → improve.

## Skills

| Skill | Description |
|-------|-------------|
| `optimize-skill-performance-and-instructions` | Runs the full optimization cycle |
| `setup-skill-performance` | Sets up performance testing for a skill |
| `optimize-skill-performance` | Improves how well a skill executes its tasks |
| `optimize-skill-instructions` | Improves how reliably a skill gets invoked |
| `compare-skill-model-performance` | Compares how a skill performs across different Claude models |

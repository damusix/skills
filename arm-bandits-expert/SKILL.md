---
name: arm-bandits-expert
description: "Implements, evaluates, and deploys multi-armed bandit algorithms — including Thompson Sampling, UCB, epsilon-greedy, LinUCB, EXP3, and contextual bandits. Covers algorithm selection, experiment harnesses, offline evaluation (IPS, Doubly Robust), infrastructure patterns, and correctness verification. Use when the user asks about multi-armed bandits, exploration-exploitation tradeoffs, adaptive experiments, A/B testing alternatives, online optimization, bandit-based recommendation or personalization systems, or contextual bandits."
---

# Multi-Armed Bandits Expert

Guide the user based on their actual need. Do not lecture; respond to what they're doing.

## Routing

Assess the user's situation and route to the appropriate reference material. Read the relevant file(s) from `skill/references/` before responding.

### Entry Paths

**"I need to learn about bandits"** → Start with `tier-1-core-algorithms.md`. Progress to tier 2/3 only when the user is ready or asks.

**"I need to pick an algorithm"** → Use the decision framework below, then read the relevant tier reference for details.

**"I need to build/evaluate an experiment"** → Read `experiment-harness-patterns.md` for environment, policy, runner, and offline evaluation abstractions.

**"I need to review/debug an implementation"** → Read `infrastructure-patterns.md` for testing patterns and bug checklists. Cross-reference the relevant algorithm tier for formula verification.

**"I need to deploy to production"** → Read `infrastructure-patterns.md` for serving, reward pipelines, monitoring, and safety guardrails.

**"I need to understand the business case"** → Read `business-applications.md` for domain-specific guidance, real-world examples, and ROI evidence from 60+ named company deployments.

## Decision Framework — Picking an Algorithm

Present trade-offs. Never prescribe a single "best" algorithm without context.

### Step 0: Does the user specify an algorithm?

If the task names a specific algorithm (e.g. "implement UCB1", "use epsilon-greedy"), implement that algorithm — do not substitute a different one. Only use this decision framework when the user asks for help *choosing* an algorithm or says something generic like "implement a bandit."

### Step 1: What kind of rewards?

| Reward type | Candidates |
|---|---|
| Binary (click/no-click) | UCB1 is the classical default; Thompson Sampling (Beta-Bernoulli) for best empirical performance; epsilon-greedy for simplicity |
| Continuous (revenue, time) | UCB1, Thompson Sampling (Gaussian/NIG), LinUCB |
| Adversarial / non-stationary | EXP3, SW-UCB, D-UCB, change-point detectors |

### Step 2: Do you have context features?

| Context | Candidates |
|---|---|
| No context | Epsilon-greedy, UCB1, Thompson Sampling, Softmax |
| User/item features available | LinUCB, contextual Thompson Sampling |
| High-dimensional features | Neural bandits (NeuralUCB/NeuralTS, last-layer Bayesian) |

### Step 3: What's your constraint?

| Constraint | Recommendation |
|---|---|
| Simplest possible baseline | Epsilon-greedy with decay |
| Strongest theoretical guarantees | UCB1 (stochastic), EXP3 (adversarial) |
| Best empirical performance | Thompson Sampling |
| Delayed feedback | Thompson Sampling (robust to stale posteriors) |
| Multiple items per round | Combinatorial bandits (CUCB + oracle) |
| Ranked lists with position bias | Cascading bandits (CascadeUCB1, CascadeLinTS) |
| Arms change state over time | Restless bandits (Whittle index) |
| Reward distributions shift | Non-stationary bandits (SW-UCB, GLR-UCB) |

### Step 4: Maturity reality check

| Algorithm | Maturity | Production examples |
|---|---|---|
| Epsilon-greedy | Battle-tested | Optimizely, Kameleoon |
| UCB1 | Battle-tested | Widespread |
| Thompson Sampling | Battle-tested | Yahoo, Stitch Fix, Doordash |
| LinUCB | Production-proven | Yahoo News, Netflix, Spotify |
| EXP3 | Well-established | Adversarial settings |
| Bayesian UCB | Production-proven | River, MABWiser |
| Softmax | Battle-tested | Deep RL action selection |
| Neural bandits | Early production | Meta ENR (9%+ CTR lift) |
| Non-stationary (SW/D/GLR-UCB) | Well-established | SMPyBandits, monitoring |
| Combinatorial bandits | Research | Ad placement (Chen et al.) |
| Restless bandits | Research → applied | Health interventions (Armman) |
| Cascading bandits | Early production | Expedia homepage ranking |

## Build Phases

1. **Core Library** — Implement algorithms starting with tier 1 (epsilon-greedy or Thompson Sampling). See `tier-1-core-algorithms.md` through `tier-3-production-algorithms.md`.
2. **Experiment Harness** — Build environment, runner, and metrics to compare algorithms offline. See `experiment-harness-patterns.md`.
3. **Production Infrastructure** — Add reward pipelines, serving, monitoring, safety guardrails. See `infrastructure-patterns.md`.

## Reference Files

| File | Contents |
|---|---|
| `references/tier-1-core-algorithms.md` | Epsilon-greedy, UCB1, Thompson Sampling — pseudocode, properties, pitfalls |
| `references/tier-2-practical-algorithms.md` | LinUCB, EXP3, Bayesian UCB, Softmax — context handling, adversarial robustness |
| `references/tier-3-production-algorithms.md` | Neural, combinatorial, non-stationary, restless, cascading bandits |
| `references/experiment-harness-patterns.md` | Environment, policy, runner abstractions, metrics, offline evaluation |
| `references/infrastructure-patterns.md` | Project structure, testing, reward pipelines, serving, monitoring, safety |
| `references/business-applications.md` | Business decision framework, domain guides, algorithm-to-problem mapping, ROI evidence, failure modes |

# Infrastructure Patterns for Multi-Armed Bandits

Framework-agnostic patterns for project structure, testing, reward pipelines, model serving, configuration, monitoring, and safety. Language-specific notes are collected at the end.

---

## Project Structure

A convergent pattern emerges across Python, TypeScript, and Go bandit libraries:

- **Algorithms organized by type**: one file per algorithm or an `algorithms/` directory.
- **Single public entry point**: a `MAB` class, `Bandit` struct, or `SimpleBandit` constructor that dispatches to strategy implementations.
- **Tests co-located or parallel**: Go uses `*_test.go` beside source; Python uses a `tests/` directory; TypeScript uses `__tests__/`.
- **Examples as a separate directory**: Jupyter notebooks, demo apps, or CLI scripts.
- **Configuration via constructor parameters**, not config files. Hyperparameters are arguments, not YAML.

Notable implementations:

| Library | Language | Organization |
|---|---|---|
| MABWiser | Python | Flat module, private `_ucb1.py` modules |
| contextualbandits | Python | By lifecycle: `online/`, `offpolicy/`, `evaluation/` |
| SMPyBandits | Python | By abstraction: `Policies/`, `Arms/`, `Environment/` |
| SimpleBandit | TypeScript | Zero deps, <700 lines, JSON serialization-first |
| Stitch Fix mab | Go | One file per strategy, interface-based composition |

---

## Testing Patterns

Five patterns are needed. None is sufficient alone.

### 1. Seeded RNG + Deterministic Assertions

Fixed seed produces deterministic arm selections. Assert exact sequences. This is the dominant pattern and every serious framework supports seeds.

### 2. Statistical Convergence Bounds

Run N trials, assert best arm is selected more than X% of the time after convergence. UCB1 regret should grow O(log n). These tests are inherently slower and need tolerance.

### 3. Property-Based Invariants (Not Stochastic)

These are deterministic properties that must always hold:

- Probabilities sum to 1.0
- Counts are non-negative
- Updating with a positive reward increases the estimate
- Selected arm is from the valid set
- Serialization roundtrips produce identical state

### 4. Boundary and Edge Cases

- Single arm (always select it)
- All arms equal (roughly uniform selection)
- Zero rewards (no crash, no NaN)
- Large rewards (numerical stability)

### 5. Test Doubles for Dependencies

Reward sources should be interfaces so they can be stubbed. Examples: Stitch Fix uses `ContextualRewardStub` and `HTTPRewardStub`; Vizier mocks suggestion services.

### 4-Layer CI/CD Architecture

| Layer | Scope | Budget | What It Covers |
|---|---|---|---|
| L1 Deterministic | <10s | Every commit | Seeded RNG + golden values |
| L2 Property-based | <60s | Every commit | Hypothesis/fast-check invariants |
| L3 Statistical | <5min | Pre-merge | Exploration rate verification with tolerance |
| L4 Regret regression | <30min | Nightly/release | Bounds + baseline comparison |

### Seed Strategy

From "To Seed or Not to Seed" (ICST 2022): Seed the **environment** for reproducibility. Do **not** seed the algorithm -- verify it works across random initializations. Use `pytest.approx` or equivalent with statistical tolerance.

### Property-Based Testing

- **Python**: Hypothesis `RuleBasedStateMachine` with `@invariant`. PyBandits is the only bandit library using this pattern.
- **JS/TS**: fast-check with `fc.commands()` and `fc.modelRun()`.
- **Five invariant categories**: count consistency, reward estimate accuracy, exploration bounds, monotonicity/convergence, selection logic correctness.

### Common Bug Checklist by Algorithm

**Epsilon-Greedy**:
- Epsilon must be in (0, 1)
- Exploration flag logic is correct (random < epsilon means explore, not exploit)
- Random tie-breaking among equal arms
- Decaying epsilon actually decreases over time

**UCB1**:
- Uses `ln(t)` not `log10(t)`
- Parameter order in confidence bound is correct
- Division by zero guarded when arm count is 0
- Rewards scaled to expected range
- Random tie-breaking among equal upper bounds

**Thompson Sampling**:
- Prior is `Beta(1, 1)` not `Beta(0, 0)`
- Success and failure counts are not swapped
- Counts update on every pull, not just on reward=1
- Variance propagates correctly in Gaussian variant

**EXP3**:
- Importance weighting is present in weight updates
- Exp-normalize trick prevents overflow
- Weight renormalization after updates
- Non-finite value detection (NaN, Inf)

**LinUCB**:
- A matrix initialized with regularization (`I * lambda`)
- Feature vectors normalized
- Uses `solve()` not `inv()` for numerical stability
- Condition number monitored for degenerate matrices

---

## Reward Pipeline Design

The gap between research (pull arm, get reward) and production (serve, track, join, delay, update) is the hardest infrastructure problem.

### Three Architectures

**1. Streaming Join (Udemy pattern)**

Events flow through Kafka into Spark Structured Streaming, which performs funnel joins and sessionization, then updates the model and pushes weights to a Redis cache. Tracking IDs stitch events across time.

- Trade-off: lowest latency for updates, highest infrastructure complexity.

**2. Reward Microservice (Stitch Fix pattern)**

The allocation engine queries a `RewardSource` microservice that returns distribution parameters. The strategy computes selection probabilities from those parameters. Reward computation is fully decoupled from arm selection.

- Trade-off: clean separation of concerns, but adds a network hop and a service to maintain.

**3. Batch Update (Optimizely, Kameleoon pattern)**

Hourly aggregation updates posteriors and pushes new weights. Simpler infrastructure, higher latency.

- Trade-off: simplest to build and operate, but serves stale decisions for up to an hour.

### Delayed Reward Handling

- **Thompson Sampling is most robust**: stochastic selection creates diversity even with stale posteriors.
- **UCB degrades silently**: repeats the same deterministic choice while waiting for rewards.
- Use windowed joins in Kafka for event matching.
- Predict long-term rewards from short-term proxy signals when full feedback is slow.

---

## Model Serving

### Four Patterns

| Pattern | Latency | When to Use | Examples |
|---|---|---|---|
| Embedded | <1ms | Most bandit use cases | MABWiser in Python, SimpleBandit in browser, Stitch Fix in Go |
| Cache-backed | 1-5ms | High-traffic, pre-computable | Udemy (Redis) |
| Service-based | 10-100ms (REST), 2-25ms (gRPC) | Complex optimization, shared service | Vizier, Ax |
| Kubernetes-native | Varies | Cloud-native with traffic management | KServe InferenceService with canary rollouts |

Bandits are simple enough that embedded serving is usually the right default. Move to cache-backed or service-based only when you need shared state or centralized management.

### Gold Standard: Deterministic Serving (Stitch Fix)

When users must see consistent results (no flickering on refresh, same user always gets the same arm), use deterministic hash-based assignment — even with stochastic algorithms like Thompson Sampling, Softmax, or EXP3. The algorithm computes *probabilities*, but the final assignment is deterministic:

1. Fetch rewards from `RewardSource`
2. Compute selection probabilities via `Strategy` (e.g., Thompson Sampling posteriors → probability vector)
3. Sample deterministically via `SHA1(experiment_id + unit_string) mod 1000`

```ruby
def deterministic_assign(user_id, experiment_id, arm_probabilities)
  # Hash the user+experiment to a number in [0, 1)
  hash_input = "#{experiment_id}:#{user_id}"
  hash_value = Digest::SHA1.hexdigest(hash_input).to_i(16) % 10000 / 10000.0

  # Walk the probability vector to assign an arm
  cumulative = 0.0
  arm_probabilities.each_with_index do |prob, arm|
    cumulative += prob
    return arm if hash_value < cumulative
  end
  arm_probabilities.length - 1  # fallback to last arm
end
```

Same input always produces the same output. This enables debugging, consistency across requests, and horizontal scaling without coordination. The key insight: stochastic algorithms and deterministic serving are not in conflict — the algorithm explores across the *population* (different users hash to different arms), while each individual user gets a stable experience.

---

## Configuration Management

### Three Patterns

**Constructor parameters** (most common): pass hyperparameters at construction time. Simple, explicit, testable. Preferred for libraries.

**Declarative config** (Vizier, SMPyBandits): YAML or dict with search space definitions. Useful when non-engineers configure experiments.

**Feature flags** (Optimizely, Kameleoon): platform-level configuration, dynamic without code deployment. Appropriate for SaaS experimentation platforms.

### Dynamic Reconfiguration

Reward models should update independently of the allocation engine (as in Stitch Fix). No restart needed when reward signals change. This requires the decoupled architecture described in the reward pipeline section.

---

## Monitoring and Observability

### Algorithm Health

- Exploration/exploitation ratio over time
- Arm selection distribution (detect collapsed exploration)
- Reward rate per arm
- Convergence indicators (e.g., selection entropy decreasing)

### System Health

- Kafka consumer lag
- Redis latency
- Streaming application health and checkpoint status

### Experiment Health

- Per-arm conversion rates with confidence intervals
- Sample sizes per arm
- Cumulative regret estimates

### Alerting

Automated supervisor checks are critical. Udemy checks every 5 minutes and recovers autonomously 99 out of 100 times. Combine with SLO monitoring and anomaly detection on reward distributions.

---

## Safety Guardrails

These are non-negotiable in production.

1. **Default arm fallback**: when the reward service is unavailable, serve a safe default. Never fail open with random exploration.
2. **Exploration caps**: limit exploration to X% of traffic. Yahoo uses bucketing; Twitter caps at 1%; Spotify pre-filters to top-100 candidates before exploring.
3. **SLO checks**: monitor arm performance against minimum thresholds. Pull underperforming
   arms automatically. Implement a minimum reward threshold per arm — if an arm's observed
   reward rate drops below the threshold for a sustained window, remove it from the candidate
   set or force-assign it to the default arm:

   ```ruby
   def check_arm_slo(arm, min_reward_rate: 0.01, window: 1000)
     return true if @counts[arm] < window  # not enough data yet
     if @values[arm] < min_reward_rate
       disable_arm(arm)
       log_warning("Arm #{arm} below SLO: #{@values[arm]} < #{min_reward_rate}")
       return false
     end
     true
   end
   ```

   SLO checks should run on every `update()` call, not just periodically — catching a degraded arm early prevents wasting traffic.

4. **Abort mechanisms**: budget-doubling schemes interrupt if cumulative reward falls below a "ruin" threshold.
5. **Null arm handling**: redistribute probability mass away from disabled or removed arms. Probabilities must still sum to 1.0.

---

## Anti-Patterns

1. **Coupling reward computation to arm selection** -- prevents independent updates and scaling.
2. **Not handling delayed rewards** -- UCB degrades silently; Thompson Sampling masks the problem but does not solve it.
3. **Mutable global state in policies** -- hard to test, debug, and scale horizontally.
4. **Skipping fallback mechanisms** -- system fails when the reward service goes down.
5. **Testing only happy paths** -- misses numerical edge cases (NaN, overflow, division by zero).
6. **No experiment tracking** -- cannot reproduce results or audit decisions.
7. **Batch-only updates for latency-sensitive applications** -- an hour of suboptimal serving after each change.
8. **Unrestricted exploration** -- degrades user experience and wastes traffic on bad arms.

---

## Infrastructure Checklist

### Day 1 (Prototype)

- [ ] Policy with `select_arm()` / `update()` interface
- [ ] Seeded RNG for reproducible testing
- [ ] Basic convergence test (best arm selected >X% after N rounds)
- [ ] Serialization/deserialization of policy state
- [ ] Default arm fallback
- [ ] Minimum reward threshold per arm (disable arms below SLO)

### Day 30 (Production)

- [ ] Reward pipeline (even batch/hourly is fine to start)
- [ ] Experiment tracking (config + results logging)
- [ ] Monitoring dashboard (arm selection distribution, reward rates)
- [ ] Exploration cap and safety guardrails
- [ ] Deterministic serving for consistent user experience

### Day 90 (Scale)

- [ ] Streaming reward pipeline
- [ ] Separated reward computation from arm selection
- [ ] Offline evaluation (replay, IPS, DR)
- [ ] Automated alerting on arm performance degradation
- [ ] Model versioning and rollback

---

## Language-Specific Notes

### Python

- **Testing**: pytest with `pytest.approx` for statistical tolerance; coverage.py for coverage.
- **Performance**: Cython for hot paths (contextualbandits achieves 9.4% Cython); numpy vectorization for batch operations.
- **Packaging**: Poetry or pip; pre-commit hooks for linting.
- **Serving**: Flask or FastAPI for REST; embedded for most use cases.

### TypeScript / JavaScript

- **Testing**: Jest; ESLint + Prettier for code quality.
- **Design**: Zero-deps preferred for browser bundles; Promise-based async interface.
- **Serialization**: JSON-first (`toJSON()` / `fromJSON()`); critical for browser persistence.
- **Serving**: Embedded in browser or Node process.

### Go

- **Testing**: `go test` (built-in); table-driven tests are idiomatic.
- **Design**: Interface-based composition (`RewardSource`, `Strategy`, `Sampler`); single package with one file per strategy.
- **Numerics**: gonum for linear algebra and distributions.
- **Serving**: gRPC for high-throughput internal services.

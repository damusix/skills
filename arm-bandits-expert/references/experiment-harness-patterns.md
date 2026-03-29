# Experiment Harness Patterns

Convergent patterns observed across 13+ bandit frameworks (SMPyBandits, MABWiser, BanditPyLib,
BanditLib, contextualbandits, Open Bandit Pipeline, Vowpal Wabbit, Stitch Fix, gym-bandits,
BanditLab JS, Optimizely, AgileRL, and others). Framework-agnostic — the interfaces below
represent where independent implementations ended up, not any single library's API.

---

## Environment Abstraction

Two distinct lineages, split by whether the arms are simulated or learned from data.

### Synthetic Environments (Research)

Configure arm distributions directly. Used for algorithm comparison and regret analysis.

```ruby
class Arm
  def initialize(distribution, params)
    @distribution = distribution
    @params = params
  end

  def draw
    # Sample a reward from the arm's distribution
    @distribution.sample(@params)
  end

  def mean
    # True expected reward (known in simulation)
    @distribution.mean(@params)
  end
end

class SyntheticEnvironment
  def initialize(arms)
    @arms = arms
  end

  def pull(arm_id)
    @arms[arm_id].draw
  end

  def optimal_reward
    @arms.map { |a| a.mean }.max
  end

  def num_arms
    @arms.length
  end
end
```

### Data-Driven Environments (Production)

Learn from logged decisions and rewards. The environment replays historical data or serves
features from a dataset. MABWiser, contextualbandits, Open Bandit Pipeline.

```ruby
class LoggedEnvironment
  def initialize(logged_data)
    # logged_data: list of (context, action, reward, propensity) tuples
    @data = logged_data
    @cursor = 0
  end

  def next_context
    @data[@cursor].context
  end

  def reveal_reward(arm_id)
    # Only reveal reward if arm_id matches the logged action
    # (counterfactual rewards are unobserved)
    entry = @data[@cursor]
    @cursor += 1
    return entry.reward if arm_id == entry.action
    nil  # unobserved — must use estimator
  end

  def logged_propensity
    @data[@cursor].propensity
  end
end
```

### Non-Stationary Variants

Arm distributions change over time. Separate classes in SMPyBandits:

```ruby
# Piecewise stationary: arms change at known or unknown breakpoints
class PieceWiseStationaryEnvironment
  def initialize(arms_per_segment, breakpoints)
    @segments = arms_per_segment  # list of arm-lists
    @breakpoints = breakpoints     # list of time steps
    @t = 0
  end

  def pull(arm_id)
    segment = @breakpoints.rindex { |bp| @t >= bp } || 0
    @t += 1
    @segments[segment][arm_id].draw
  end
end

# Markovian: arm parameters follow a Markov chain
# Continuously drifting: arm means shift by small increments each round
```

---

## Policy Abstraction

The core interface converged independently across every framework studied.

### Canonical Interface

```ruby
class Policy
  def select_arm(context = nil)
    # Return the index of the arm to pull
    raise NotImplementedError
  end

  def update(arm_id, reward, context = nil)
    # Incorporate observed reward into internal state
    raise NotImplementedError
  end
end
```

### Framework Variations

Same semantics, different method names:

```ruby
# SMPyBandits style
class SMPyBanditsPolicy
  def choice         # → arm_id (no context)
  end
  def get_reward(arm_id, reward)
  end
end

# MABWiser / contextualbandits style (scikit-learn compatible)
class SklearnPolicy
  def fit(decisions, rewards, contexts = nil)       # batch training
  end
  def predict(contexts)                              # → arm_ids
  end
  def partial_fit(decisions, rewards, contexts = nil) # incremental update
  end
end

# BanditLab JS style (async, serializable)
class AsyncPolicy
  def select          # → Promise<arm_id>
  end
  def reward(arm_id, value)  # → Promise<void>
  end
  def serialize       # → JSON string
  end
end

# Stitch Fix Go style (stateless, pure function)
class StatelessPolicy
  def compute_probs(rewards)
    # Input: per-arm reward histories
    # Output: probability distribution over arms
    # No internal state — caller manages persistence
  end
end
```

### Serialization Patterns

How policies save and restore state across processes or restarts:

| Pattern | Used by | Trade-off |
|---|---|---|
| JSON | BanditLab JS | Human-readable, portable, slow for large states |
| Pickle | Most Python frameworks | Fast, compact, version-fragile |
| HDF5 | SMPyBandits | Good for large numerical arrays |
| Stateless | Stitch Fix Go | No serialization needed — state is external |

---

## Runner

The orchestration layer. Configuration-driven — takes environments, policies, and run
parameters, then manages execution across all combinations.

### Canonical Interface

```ruby
class Runner
  def initialize(environment, policies, config)
    @environment = environment
    @policies = policies
    @config = config  # horizon, repetitions, seed, parallelism
  end

  def run
    results = Results.new(@policies)
    seeds = pre_generate_seeds(@config.repetitions, @config.seed)

    parallel_map(@config.repetitions, n_jobs: @config.n_jobs) do |rep|
      rng = RandomGenerator.new(seeds[rep])

      @policies.each do |policy|
        policy_copy = policy.deep_clone
        trajectory = Trajectory.new

        @config.horizon.times do |t|
          arm = policy_copy.select_arm
          reward = @environment.pull(arm, rng: rng)
          policy_copy.update(arm, reward)

          trajectory.record(
            arm: arm,
            reward: reward,
            regret: @environment.optimal_reward - reward,
            smooth_regret: @environment.optimal_reward - @environment.arm_mean(arm)
          )
        end

        results.add_trajectory(policy_copy.name, rep, trajectory)
      end
    end

    results
  end
end
```

### Framework-Specific Runner Patterns

```ruby
# SMPyBandits: dict-based configuration
config = {
  horizon: 10_000,
  repetitions: 1_000,
  n_jobs: 4,
  environments: [
    { arm_type: "Bernoulli", params: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] }
  ],
  policies: [
    { name: "UCB1" },
    { name: "ThompsonSampling" },
    { name: "EpsilonGreedy", epsilon: 0.1 }
  ]
}
evaluator = Evaluator.new(config)
evaluator.start_all_experiments

# MABWiser Simulator: logged-data replay with batches
simulator = Simulator.new(
  bandits: [mab_ucb, mab_ts, mab_greedy],
  decisions: logged_decisions,
  rewards: logged_rewards,
  contexts: logged_contexts,
  test_size: 0.3,
  batch_size: 100,
  is_ordered: true,
  seed: 42
)
simulator.run

# BanditPyLib: protocol-mediated
protocol = SinglePlayerProtocol.new(bandit, learners)
protocol.play(trials: 20, horizon: 5_000)
```

### Parallelism

The natural parallelism unit is the Monte Carlo repetition — each trial is independent.

```ruby
# Each repetition gets its own RNG, its own policy copy, its own trajectory
# No shared mutable state between repetitions
parallel_map(repetitions, n_jobs: num_cores) do |rep|
  run_single_trial(seed: seeds[rep])
end

# Python: joblib.Parallel(n_jobs=n_jobs)(delayed(run_trial)(seed) for seed in seeds)
# Go: goroutines with WaitGroup, one per repetition
```

---

## Metrics

### Non-Negotiable (Every Framework)

These three appear in every framework without exception:

```ruby
class Results
  def cumulative_regret(policy)
    # Research metric: how much reward was left on the table
    # cumsum(optimal_reward - observed_reward) per round
    trajectories[policy].map do |traj|
      traj.regrets.cumulative_sum
    end
  end

  def cumulative_reward(policy)
    # Production metric: total reward collected
    trajectories[policy].map do |traj|
      traj.rewards.cumulative_sum
    end
  end

  def arm_pull_counts(policy)
    # Per-arm selection frequency across all rounds
    trajectories[policy].map do |traj|
      traj.arms.histogram
    end
  end

  def average_reward_over_time(policy)
    # Running average: reward_sum[0..t] / (t + 1)
    trajectories[policy].map do |traj|
      traj.rewards.running_mean
    end
  end
end
```

### Extended Metrics

```ruby
class Results
  def best_arm_rate(policy)
    # Fraction of rounds where the optimal arm was selected
    trajectories[policy].map do |traj|
      optimal_arm = environment.optimal_arm
      traj.arms.count { |a| a == optimal_arm }.to_f / traj.length
    end
  end

  def instantaneous_regret(policy)
    # Per-round regret (not cumulative) — shows learning speed
    trajectories[policy].map do |traj|
      traj.regrets  # raw per-round values
    end
  end

  def terminal_regret_distribution(policy)
    # Final cumulative regret across all repetitions — for boxplots/histograms
    trajectories[policy].map do |traj|
      traj.regrets.sum
    end
  end

  def running_time(policy)       # wall-clock seconds per trial
  end
  def memory_consumption(policy) # peak memory per trial
  end
end
```

### Regret Computation: Noisy vs. Smooth

```ruby
# Noisy regret: uses actual observed rewards (high variance across repetitions)
noisy_regret_t = max_reward_t - observed_reward_t
# cumulative: cumsum(noisy_regret)

# Smooth regret (preferred): uses true arm means (removes reward noise)
smooth_regret_t = best_arm_mean - selected_arm_mean
# cumulative: cumsum(smooth_regret)
# Produces cleaner learning curves, easier to compare algorithms
```

### Aggregation Across Repetitions

```ruby
def aggregate(per_rep_curves)
  mean_curve = per_rep_curves.mean(axis: :repetitions)
  stderr = per_rep_curves.std(axis: :repetitions) / sqrt(num_repetitions)
  confidence_interval = [mean_curve - 1.96 * stderr, mean_curve + 1.96 * stderr]

  # For terminal regret: histogram or boxplot across repetitions
  terminal_values = per_rep_curves.map { |c| c.last }
  { mean: mean_curve, ci: confidence_interval, terminal: terminal_values }
end
```

---

## Reproducibility

### Seeded RNG

Every source of randomness must be seeded. This is non-negotiable for valid experiments.

```ruby
class ReproducibleRunner
  def initialize(master_seed)
    @master_rng = RandomGenerator.new(master_seed)
  end

  def pre_generate_seeds(num_repetitions)
    # Generate all seeds upfront so adding/removing policies
    # does not change the reward sequences
    num_repetitions.times.map do
      @master_rng.next_int
    end
  end

  def run_trial(seed)
    rng = RandomGenerator.new(seed)
    env_rng = rng.fork    # environment reward draws
    policy_rng = rng.fork # policy exploration randomness
    # Both seeded from the same trial seed
  end
end
```

### Configuration Logging

```ruby
# Save the full configuration alongside every result set
def save_experiment(results, config, path)
  write_json(path + "/config.json", {
    environment: config.environment.to_hash,
    policies: config.policies.map { |p| p.to_hash },
    horizon: config.horizon,
    repetitions: config.repetitions,
    master_seed: config.seed,
    timestamp: now_utc,
    framework_version: VERSION
  })
  write_binary(path + "/results.bin", results)
end
```

### Deterministic Allocation (Production)

```ruby
# Stitch Fix pattern: hash-based assignment for consistent user-to-arm mapping
def assign_arm(experiment_id, user_id, num_arms)
  hash = sha1(experiment_id + ":" + user_id)
  bucket = hash_to_int(hash) % 1000
  bucket * num_arms / 1000
end

# Same user always gets same arm for same experiment
# No state needed — pure function of inputs
# Works across distributed systems without coordination
```

### Reproducibility Verification

```ruby
# Test 1: determinism — same seed produces identical results
results_a = runner.run(seed: 12345)
results_b = runner.run(seed: 12345)
assert results_a.cumulative_regret == results_b.cumulative_regret

# Test 2: sensitivity — different seeds produce different results
results_c = runner.run(seed: 99999)
assert results_a.cumulative_regret != results_c.cumulative_regret

# Test 3: fairness — all policies face the same reward sequences per seed
# Pre-generate rewards, then replay for each policy
```

---

## Offline Evaluation

Evaluating new policies from logged data without running live traffic. Critical for
production systems where bad policies cost real money.

### Replay Method (Li et al. 2010)

The simplest approach. Only accept events where the new policy would have taken
the same action as the logging policy.

```ruby
class ReplayEvaluator
  def evaluate(new_policy, logged_data)
    total_reward = 0.0
    accepted = 0

    logged_data.each do |context, action, reward, propensity|
      chosen_arm = new_policy.select_arm(context)

      if chosen_arm == action
        # New policy agrees with logged action — we can use this reward
        total_reward += reward
        accepted += 1
        new_policy.update(chosen_arm, reward, context)
      end
      # Otherwise discard — we have no counterfactual reward
    end

    # Discards ~(K-1)/K of data for K arms
    # Requires the logging policy to be randomized (nonzero propensity for all arms)
    total_reward / accepted
  end
end
```

### Inverse Propensity Scoring (IPS)

Reweights each observation by the ratio of new policy probability to logging policy
probability. Unbiased but potentially high variance.

```ruby
class IPSEvaluator
  def evaluate(new_policy, logged_data)
    n = logged_data.length
    weighted_sum = 0.0

    logged_data.each do |context, action, reward, propensity|
      new_prob = new_policy.action_probability(action, context)
      importance_weight = new_prob / propensity
      weighted_sum += importance_weight * reward
    end

    # V_hat(pi) = (1/n) * sum( pi(a|x) / pi_0(a|x) * r )
    # Unbiased but high variance when new_prob >> propensity
    weighted_sum / n
  end
end
```

### Self-Normalized IPS (SNIPS)

Normalizes importance weights to sum to 1. Reduces variance at the cost of slight bias.

```ruby
class SNIPSEvaluator
  def evaluate(new_policy, logged_data)
    weights = []
    weighted_rewards = []

    logged_data.each do |context, action, reward, propensity|
      w = new_policy.action_probability(action, context) / propensity
      weights << w
      weighted_rewards << w * reward
    end

    # Normalize: weights sum to 1
    weighted_rewards.sum / weights.sum
  end
end
```

### Doubly Robust (DR)

Combines a reward model with importance weighting. Consistent if EITHER the reward model
OR the propensity model is correct. Default estimator in Vowpal Wabbit.

```ruby
class DoublyRobustEvaluator
  def initialize(reward_model)
    @reward_model = reward_model  # predicts E[reward | context, arm]
  end

  def evaluate(new_policy, logged_data)
    n = logged_data.length
    total = 0.0

    logged_data.each do |context, action, reward, propensity|
      chosen_arm = new_policy.select_arm(context)
      predicted_reward = @reward_model.predict(context, chosen_arm)
      importance_weight = new_policy.action_probability(action, context) / propensity
      residual = reward - @reward_model.predict(context, action)

      # V_hat = (1/n) * sum( reward_model(x, pi(x)) + pi(a|x)/pi_0(a|x) * (r - reward_model(x, a)) )
      total += predicted_reward + importance_weight * residual
    end

    total / n
  end
end
```

### Supervised Metrics Can Mislead

Critical insight from production experience (Twitter): conventional supervised metrics
like PR-AUC can diverge from actual bandit performance. A greedy policy that always picks
the arm with highest predicted CTR will maximize PR-AUC on logged data — but will
underperform on actual CTR because it never explores.

Always evaluate bandit policies with bandit-aware estimators (IPS, DR, replay), not
classification metrics.

### Available Implementations

| Framework | Estimators |
|---|---|
| Vowpal Wabbit | IPS, DR, DM, MTR, SNIPS (5 cost estimation methods) |
| Open Bandit Pipeline | IPS, SNIPS, DR, Switch-DR, DRos, and 5+ more (10+ estimators) |
| contextualbandits | Rejection sampling, DR, NCIS |

---

## Implementation Evaluation Mode

Property-based checks for validating that a bandit implementation is correct.

### Invariant Checks

```ruby
def verify_count_consistency(policy, total_rounds)
  # Sum of all arm counts must equal total rounds pulled
  assert policy.arm_counts.sum == total_rounds
  # No arm count should be negative
  policy.arm_counts.each do |count|
    assert count >= 0
  end
end

def verify_reward_estimates(policy, reward_range)
  policy.arm_values.each_with_index do |value, arm|
    next if policy.arm_counts[arm] == 0
    # Estimated means must be within the reward range
    assert value >= reward_range.min
    assert value <= reward_range.max
  end
  # Means must be exact running averages of observed rewards
end

def verify_exploration_bounds(policy)
  # UCB-family: every arm must be tried at least once
  if policy.is_a?(UCBPolicy)
    policy.arm_counts.each do |count|
      assert count > 0, "UCB must try every arm"
    end
  end

  # Thompson Sampling: every arm must have nonzero selection probability
  if policy.is_a?(ThompsonSampling)
    policy.num_arms.times do |arm|
      assert policy.selection_probability(arm) > 0
    end
  end
end

def verify_selection_logic(policy)
  # Epsilon=0 must always pick the arm with highest estimated reward
  greedy = EpsilonGreedy.new(num_arms, epsilon: 0.0)
  train(greedy, known_data)
  assert greedy.select_arm == greedy.arm_values.index_of_max

  # UCB must select the arm that maximizes mean + confidence_bonus
  ucb = UCB1.new(num_arms)
  train(ucb, known_data)
  expected_arm = (0...num_arms).max_by do |a|
    ucb.arm_values[a] + ucb.confidence_bonus(a)
  end
  assert ucb.select_arm == expected_arm
end

def verify_serialization_roundtrip(policy)
  serialized = policy.serialize
  restored = Policy.deserialize(serialized)
  assert restored.arm_counts == policy.arm_counts
  assert restored.arm_values == policy.arm_values
  assert restored.select_arm == policy.select_arm  # same state, same decision
end
```

### Convergence Sanity Checks

```ruby
def verify_greedy_convergence
  # Epsilon=0 after warmup must always pick the best arm
  env = SyntheticEnvironment.new([Arm.new(0.3), Arm.new(0.9)])
  policy = EpsilonGreedy.new(2, epsilon: 0.0)

  # Warmup: pull each arm 100 times
  2.times do |arm|
    100.times { policy.update(arm, env.pull(arm)) }
  end

  # After warmup, must always select arm 1 (mean 0.9)
  100.times { assert policy.select_arm == 1 }
end

def verify_sublinear_regret
  # UCB on a clear best arm should have regret growing as O(log T), not O(T)
  env = SyntheticEnvironment.new(nine_arm_uniform)
  policy = UCB1.new(9)
  regrets = run_and_collect_regret(env, policy, horizon: 10_000)

  # Regret at T=10000 should be much less than T (linear would be ~5000)
  assert regrets.last < 500  # rough bound for well-separated arms
end

def verify_thompson_posterior
  # TS on Bernoulli arms: posterior must be Beta(successes+1, failures+1)
  policy = ThompsonSampling.new(2)
  policy.update(0, 1)  # arm 0: success
  policy.update(0, 0)  # arm 0: failure
  policy.update(0, 1)  # arm 0: success

  assert policy.alpha[0] == 3  # 2 successes + 1 prior
  assert policy.beta[0] == 2   # 1 failure + 1 prior
end

def verify_trivial_environment
  # Single-arm environment: any policy must have zero regret
  env = SyntheticEnvironment.new([Arm.new(0.5)])
  policy = AnyPolicy.new(1)

  regret = run_and_collect_regret(env, policy, horizon: 1_000)
  assert regret.last == 0.0
end
```

### Standard Benchmark Environments

```ruby
# 9-arm uniform: the standard comparison environment
# Well-separated arms, clear optimal choice
nine_arm_uniform = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map do |mean|
  BernoulliArm.new(mean)
end

# Hard scenario: near-identical best arms stress-test exploration
hard_scenario = [0.005, 0.01, 0.015, 0.84, 0.85].map do |mean|
  BernoulliArm.new(mean)
end

# Standard defaults (SMPyBandits)
DEFAULT_HORIZON     = 10_000
DEFAULT_REPETITIONS = 1_000
```

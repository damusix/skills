# Tier 1: Core Bandit Algorithms

Three foundational algorithms that cover the vast majority of production use cases.
Every claim below traces to convergent evidence across multiple implementations and papers.

---

## Epsilon-Greedy

### Intuition

With probability epsilon, explore (pick a random arm). Otherwise, exploit (pick the arm
with the highest estimated reward). The simplest bandit algorithm — a good baseline.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| You need a quick baseline | You need theoretical regret guarantees |
| System complexity budget is near zero | Constant epsilon would cause unacceptable linear regret |
| You want the easiest algorithm to explain and debug | Exploration must be directed, not random |

### Pseudocode

```ruby
class EpsilonGreedy
  def initialize(num_arms, epsilon: 0.1)
    @epsilon = epsilon
    @counts = Array.new(num_arms, 0)
    @values = Array.new(num_arms, 0.0)
  end

  def select_arm
    # Cold start: if any arm has zero pulls, select it
    unpulled = @counts.each_index.select do |i|
      @counts[i] == 0
    end
    return unpulled.sample unless unpulled.empty?

    if rand < @epsilon
      # Explore: pick a random arm
      rand_int(0, num_arms - 1)
    else
      # Exploit: pick the arm with the highest mean reward
      # Random tie-breaking to avoid index bias
      max_value = @values.max
      best_arms = @values.each_index.select do |i|
        @values[i] == max_value
      end
      best_arms.sample
    end
  end

  def update(arm, reward)
    @counts[arm] += 1
    # Incremental mean update (avoids overflow)
    @values[arm] += (reward - @values[arm]) / @counts[arm]
  end
end
```

#### Epsilon Decay Schedules

Constant epsilon gives linear regret. Decay is critical for sublinear regret.

```ruby
# Linear decay
epsilon_t = max(epsilon_min, epsilon_0 - decay_rate * t)

# Exponential decay
epsilon_t = epsilon_0 * (decay ** t)

# Inverse-time decay
epsilon_t = epsilon_0 / (1.0 + decay_rate * t)
```

### Key Properties

| Property | Value |
|---|---|
| Regret | O(T) with constant epsilon; sublinear with decay |
| Hyperparameters | epsilon (and decay schedule) |
| Exploration style | Random |
| Computational cost | Minimal |
| Memory | O(K) — count and sum per arm |
| Implementation difficulty | Trivial |

### Common Pitfalls

- **Constant epsilon forever** — linear regret; the single most common mistake.
- **No cold-start handling** — crash or empty results when no data exists for any arm.
- **Floating-point comparison** — when arm values are nearly equal, naive comparison
  produces unstable results. Use random tie-breaking.
- **Tie-breaking bias** — selecting the first max biases toward lower-indexed arms.
  Randomly sample among tied arms.

---

## UCB1

### Intuition

Pick the arm with the highest upper confidence bound — the estimated mean reward plus an
exploration bonus that shrinks as you pull that arm more. "Optimism in the face of
uncertainty." Arms you haven't tried much get a big bonus; arms you've tried a lot get a
small one.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| You want distribution-free stochastic guarantees | The environment is adversarial (use EXP3 instead) |
| Deterministic exploration is acceptable or desired | Feedback is heavily delayed (UCB repeats deterministic choices with stale data) |
| Rewards are bounded and stochastic | You need probabilistic diversity in arm selection |

### Formula

```
UCB(a, t) = mean_reward(a) + sqrt(alpha * ln(t) / pulls(a))
```

- `mean_reward(a)` — sum of rewards for arm a / number of pulls of arm a
- `t` — total pulls across ALL arms
- `pulls(a)` — number of times arm a was pulled
- `alpha` — exploration coefficient; the classic derivation uses 2, but this is often
  parameterized (MABWiser defaults to alpha = 1.25)

### Pseudocode

```ruby
class UCB1
  def initialize(num_arms, alpha: 2.0)
    @alpha = alpha
    @counts = Array.new(num_arms, 0)
    @values = Array.new(num_arms, 0.0)
    @total_pulls = 0
  end

  def select_arm
    # Cold start: play each arm exactly once (Auer et al. 2002)
    # This handles division by zero naturally
    @counts.each_index do |i|
      return i if @counts[i] == 0
    end

    # Compute upper confidence bound for each arm
    ucb_values = @counts.each_index.map do |i|
      exploration_bonus = Math.sqrt(@alpha * Math.log(@total_pulls) / @counts[i])
      @values[i] + exploration_bonus
    end

    # Random tie-breaking
    max_ucb = ucb_values.max
    best_arms = ucb_values.each_index.select do |i|
      ucb_values[i] == max_ucb
    end
    best_arms.sample
  end

  def update(arm, reward)
    @counts[arm] += 1
    @total_pulls += 1
    # Incremental mean update
    @values[arm] += (reward - @values[arm]) / @counts[arm]
  end
end
```

### Key Properties

| Property | Value |
|---|---|
| Regret | O(sqrt(KT log T)), near-optimal (lower bound is Omega(sqrt(KT))) |
| Hyperparameters | Exploration coefficient alpha (classic = 2) |
| Exploration style | Deterministic (optimistic) |
| Computational cost | Low (log, sqrt per arm per round) |
| Memory | O(K) |
| Implementation difficulty | Easy |

### Variations

- **UCB1-Tuned** — uses sample variance in the confidence bound for tighter estimates.
- **Bayesian UCB** — replaces the Hoeffding bound with a posterior quantile (see tier 2).
- **KL-UCB** — uses a KL-divergence bound; tighter than UCB1 but requires a numerical
  solver.

### Common Pitfalls

- **log10 instead of ln** — changes the exploration rate by approximately 2.3x. Use the
  natural logarithm (LeDoux blog documents this bug).
- **Reversed parameters** — `sqrt(alpha * ln(arm_pulls) / total_pulls)` instead of the
  correct `sqrt(alpha * ln(total_pulls) / arm_pulls)`. This is a real production bug
  (Yelp/MOE issue #432).
- **Division by zero** — must initialize each arm before entering the main loop.
- **Incorrect total pull count** — `t` must count total pulls across ALL arms, not just
  the current arm.
- **Tie-breaking bias** — many languages' max functions return the first match, biasing
  toward lower-indexed arms.
- **Rewards not in [0, 1]** — the confidence bound derivation assumes bounded rewards.
  Either scale rewards to [0, 1] or adjust alpha accordingly.

---

## Thompson Sampling

### Intuition

Maintain a probability distribution (posterior) over each arm's true reward rate. Each
round, sample from each arm's posterior and pick the arm with the highest sample. Arms
with more uncertainty get wider samples — natural exploration. As data accumulates,
posteriors narrow — natural exploitation.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| Posterior is tractable (conjugate priors available) | Posterior computation is intractable (complex reward models without conjugate priors) |
| Feedback may be delayed (stochastic selection creates diversity even with stale posteriors) | You need a fully deterministic policy |
| You want minimal or zero hyperparameter tuning (Beta-Bernoulli needs none) | You cannot afford distribution sampling overhead |

### Pseudocode — Beta-Bernoulli (Binary Rewards)

The most common variant. Prior: Beta(1, 1) = uniform over [0, 1].

```ruby
class ThompsonSamplingBetaBernoulli
  def initialize(num_arms)
    # Prior: Beta(1, 1) for each arm
    @alpha = Array.new(num_arms, 1.0)
    @beta  = Array.new(num_arms, 1.0)
  end

  def select_arm
    # Sample from each arm's posterior, pick the highest
    samples = @alpha.each_index.map do |i|
      BetaDistribution.sample(@alpha[i], @beta[i])
    end

    max_sample = samples.max
    best_arms = samples.each_index.select do |i|
      samples[i] == max_sample
    end
    best_arms.sample
  end

  def update(arm, reward)
    # reward is 0 or 1
    # Posterior: Beta(1 + successes, 1 + failures)
    @alpha[arm] += reward
    @beta[arm]  += (1.0 - reward)
  end
end
```

### Pseudocode — Gaussian (Continuous Rewards, Known Variance)

```ruby
class ThompsonSamplingGaussian
  def initialize(num_arms, prior_mu: 0.0, prior_sigma: 1.0, known_sigma: 1.0)
    @mu    = Array.new(num_arms, prior_mu)
    @tau   = Array.new(num_arms, 1.0 / (prior_sigma ** 2))  # precision
    @known_tau = 1.0 / (known_sigma ** 2)
  end

  def select_arm
    samples = @mu.each_index.map do |i|
      sigma_post = Math.sqrt(1.0 / @tau[i])
      NormalDistribution.sample(@mu[i], sigma_post)
    end

    max_sample = samples.max
    best_arms = samples.each_index.select do |i|
      samples[i] == max_sample
    end
    best_arms.sample
  end

  def update(arm, reward)
    # Precision-weighted posterior update
    tau_post = @tau[arm] + @known_tau
    @mu[arm] = (@tau[arm] * @mu[arm] + @known_tau * reward) / tau_post
    @tau[arm] = tau_post
  end
end
```

### Pseudocode — Normal-Inverse-Gamma (Unknown Mean and Variance)

```ruby
class ThompsonSamplingNIG
  def initialize(num_arms, m: 0.0, nu: 1.0, alpha: 1.0, beta: 1.0)
    @m     = Array.new(num_arms, m)      # prior mean
    @nu    = Array.new(num_arms, nu)     # pseudo-observations for mean
    @alpha = Array.new(num_arms, alpha)  # shape for variance
    @beta  = Array.new(num_arms, beta)   # scale for variance
  end

  def select_arm
    samples = @m.each_index.map do |i|
      # Sample variance from Inverse-Gamma, then mean from Normal
      variance = InverseGammaDistribution.sample(@alpha[i], @beta[i])
      NormalDistribution.sample(@m[i], Math.sqrt(variance / @nu[i]))
    end

    max_sample = samples.max
    best_arms = samples.each_index.select do |i|
      samples[i] == max_sample
    end
    best_arms.sample
  end

  def update(arm, reward)
    nu_new = @nu[arm] + 1.0
    m_new  = (@nu[arm] * @m[arm] + reward) / nu_new

    @alpha[arm] += 0.5
    @beta[arm]  += 0.5 * @nu[arm] * ((reward - @m[arm]) ** 2) / nu_new
    @m[arm]  = m_new
    @nu[arm] = nu_new
  end
end
```

### Key Properties

| Property | Value |
|---|---|
| Regret | O(sqrt(KT log T)) or better; matches Lai-Robbins asymptotically |
| Hyperparameters | Prior parameters (often none needed for Beta-Bernoulli) |
| Exploration style | Probabilistic (posterior sampling) |
| Computational cost | Moderate (distribution sampling each round) |
| Memory | O(K) — sufficient statistics per arm |
| Implementation difficulty | Easy for conjugate priors; hard for complex models |

### Production Pattern: Exact Selection Probabilities

From Stitch Fix: compute exact probability that each arm is best via numerical
integration, then use deterministic hashing for consistent user experience.

```ruby
# P(arm i is best) = integral of pdf_i(x) * product of cdf_j(x) for j != i, dx
selection_probabilities = arms.map do |i|
  NumericalIntegration.compute do |x|
    pdf_i = arm_distributions[i].pdf(x)
    other_cdfs = arms.reject { |j| j == i }.map do |j|
      arm_distributions[j].cdf(x)
    end
    pdf_i * other_cdfs.reduce(:*)
  end
end

# Deterministic assignment for consistent user experience
bucket = SHA1.hash(user_id) mod 1000 / 1000.0
selected_arm = cumulative_select(selection_probabilities, bucket)
```

### Common Pitfalls

- **Wrong prior: Beta(0, 0)** — this is undefined. Always start with Beta(1, 1) for an
  uninformative prior.
- **Forgetting the +1** — the posterior is Beta(1 + successes, 1 + failures). The 1
  comes from the Beta(1, 1) prior. Initializing alpha and beta to 0 and adding successes
  directly produces an improper distribution on the first update.
- **Beta-Bernoulli for continuous rewards** — the Beta distribution models probabilities
  in [0, 1]. Use a Gaussian model for continuous rewards.
- **Design notes should explain why alternatives are wrong** — When choosing Gaussian/NIG Thompson Sampling for continuous rewards, always explain why Beta-Bernoulli would be inappropriate (it models binary 0/1 outcomes, not continuous values). Similarly, when using Beta-Bernoulli, note it assumes rewards are bounded in [0,1]. This dual explanation helps reviewers verify the model choice.
- **Posterior not actually updating** — Ray RLlib issue #29543: PyTorch
  MultivariateNormal internal state was not updating when `covariance_matrix` was set
  directly. Arms with similar rewards were chosen at random. Fix: use `scale_tril`
  parameter instead. Lesson: verify that posterior updates actually change sampling
  behavior.

---

## Cross-Cutting Concerns

### Shared Interface

Every implementation across 13+ surveyed frameworks converges on this minimal interface:

```ruby
select_arm   # → arm_index
update(arm_index, reward)  # → void
```

### Reward Tracking Patterns

Three equivalent approaches — choose based on your constraints:

```ruby
# 1. Running mean: maintain sum and count
mean = sum / count

# 2. Incremental mean: avoids overflow for large sums
mean += (reward - mean) / count

# 3. Sufficient statistics: store only what the algorithm needs
#    (e.g., alpha and beta for Thompson Sampling Beta-Bernoulli)
```

### Algorithm Comparison

| Property | Epsilon-Greedy | UCB1 | Thompson Sampling |
|---|---|---|---|
| Hyperparameters | epsilon + decay | exploration coeff | prior params (often none) |
| Exploration | Random | Deterministic | Probabilistic |
| Cold start | Random selection | Play each arm once | Prior handles it |
| Regret | O(T) constant; sublinear with decay | O(sqrt(KT log T)) | O(sqrt(KT log T)) or better |
| Delayed feedback | Degrades | Degrades (repeats same choice) | Robust |
| Best for | Quick baselines | Distribution-free guarantees | Best overall when tractable |

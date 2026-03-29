# Tier 2: Practical Bandit Algorithms

Four algorithms that extend the tier 1 foundations with contextual features, adversarial
robustness, Bayesian confidence bounds, and value-proportional exploration.
Every claim below traces to convergent evidence across multiple implementations and papers.

---

## LinUCB (Linear Upper Confidence Bound)

### Intuition

Like UCB1 but the reward model is linear in context features. For each arm, maintain a
linear regression model that predicts reward from context. The exploration bonus comes from
the uncertainty in the regression — less-observed feature combinations get bigger bonuses.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| You have user/item features and stochastic rewards | The environment is adversarial (use EXP3) |
| Production-proven: Yahoo News, Netflix artwork, Spotify homepage, Alibaba mobile | Feature dimensionality is very high without reduction |
| You need contextual personalization beyond per-arm statistics | You lack meaningful context features |

### Two Model Variants

- **Disjoint**: each arm has independent parameters. More flexible, needs more data per arm.
- **Hybrid**: shared parameters across arms plus per-arm parameters. Better cold-start for
  new arms — shared parameters transfer knowledge immediately.

### Pseudocode — Disjoint Model

```ruby
class LinUCBDisjoint
  def initialize(num_arms, dimension, alpha: 1.0)
    @alpha = alpha
    @num_arms = num_arms
    @dimension = dimension

    # Per-arm state
    @a_matrix = Array.new(num_arms) do
      Matrix.identity(dimension)  # d x d, initialized to I_d
    end
    @b_vector = Array.new(num_arms) do
      Vector.zero(dimension)      # d x 1, initialized to zero
    end
    @a_inverse = Array.new(num_arms) do
      Matrix.identity(dimension)  # cached inverse
    end
  end

  def select_arm(context)
    # Normalize context to unit length — critical for correct confidence bounds
    norm = Math.sqrt(context.map { |x| x * x }.sum)
    context = context.map { |x| x / norm } if norm > 0

    # context is a d-dimensional feature vector
    ucb_values = (0...@num_arms).map do |arm|
      theta_hat = @a_inverse[arm] * @b_vector[arm]

      # Predicted reward + exploration bonus
      predicted = context.dot(theta_hat)
      uncertainty = Math.sqrt(context.dot(@a_inverse[arm] * context))
      predicted + @alpha * uncertainty
    end

    # Random tie-breaking
    max_ucb = ucb_values.max
    best_arms = ucb_values.each_index.select do |i|
      ucb_values[i] == max_ucb
    end
    best_arms.sample
  end

  def update(arm, context, reward)
    # Rank-1 updates to A and b
    @a_matrix[arm] += context.outer_product(context)
    @b_vector[arm] += context * reward

    # Sherman-Morrison: O(d^2) instead of O(d^3) matrix inversion
    # A_inv_new = A_inv - (A_inv x x^T A_inv) / (1 + x^T A_inv x)
    a_inv = @a_inverse[arm]
    a_inv_x = a_inv * context
    denominator = 1.0 + context.dot(a_inv_x)
    @a_inverse[arm] = a_inv - a_inv_x.outer_product(a_inv_x) / denominator
  end
end
```

#### Alpha Parameter

Controls exploration-exploitation balance:

```ruby
# Conservative (more exploitation)
alpha = 0.5

# Moderate
alpha = 1.0

# Aggressive (more exploration)
alpha = 1.5

# Theoretical value (Li et al. 2010)
alpha = 1.0 + Math.sqrt(Math.log(2.0 / delta) / 2.0)
```

### Key Properties

| Property | Value |
|---|---|
| Regret | O(d * sqrt(T * ln(T))) |
| Hyperparameters | alpha (exploration), feature dimension d |
| Exploration style | Deterministic (confidence ellipsoid) |
| Computational cost | O(d^2) per step with Sherman-Morrison; O(d^3) without |
| Memory | O(K * d^2) for K arms with d-dimensional context |
| Implementation difficulty | Moderate (matrix operations, Sherman-Morrison) |

### Common Pitfalls

- **Initializing A as zeros instead of identity** — singular matrix on first inverse. The
  identity matrix acts as a ridge regression regularizer.
- **Skipping Sherman-Morrison** — O(d^3) matrix inversion per step kills latency for large d.
  Sherman-Morrison gives O(d^2) via rank-1 update.
- **Feature scaling** — LinUCB assumes features on similar scales. Unscaled features distort
  the confidence ellipsoid, causing the algorithm to over-explore along high-magnitude
  dimensions and under-explore along low-magnitude ones. Always normalize context vectors
  before passing them to the bandit. L2 normalization (divide by the vector's Euclidean norm)
  is the standard approach — it preserves direction while ensuring all features contribute
  proportionally to the confidence bound:

  ```ruby
  def normalize_context(context)
    norm = Math.sqrt(context.map { |x| x * x }.sum)
    return context if norm == 0.0
    context.map { |x| x / norm }
  end
  ```

  Alternatively, z-score standardize using running statistics (subtract mean, divide by
  standard deviation) when feature distributions are known to differ.
- **Stale inverse from numerical drift** — maintaining A^{-1} incrementally accumulates
  floating-point errors. Periodically recompute A^{-1} from A directly.
- **Context dimensionality too high** — Yahoo needed PCA from 1,200 to 5 features. Deezer
  found 100 user clusters outperformed full 97-dimensional personalization. Compress first.

---

## EXP3 (Exponential-weight for Exploration and Exploitation)

### Intuition

The only algorithm in tiers 1-2 designed for adversarial rewards — rewards can change
arbitrarily, even chosen by an adversary trying to fool you. Maintains weights for each
arm, mixes weighted probabilities with uniform exploration. Uses importance-weighted reward
estimates to correct for only observing the chosen arm's reward.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| Rewards are adversarial or non-stationary with no structural assumptions | Rewards are stochastic — EXP3 underperforms UCB/TS by design |
| You need worst-case guarantees regardless of reward generation | You have contextual features (use LinUCB) |
| The environment may actively work against you | You want to maximize empirical performance in benign settings |

EXP3 pays a price for adversarial robustness. In LeDoux's MovieLens experiments:
Bayesian UCB 0.567, Epsilon-Greedy 0.548, EXP3 0.468.

### Pseudocode

```ruby
class EXP3
  def initialize(num_arms, gamma: nil, horizon: nil)
    @num_arms = num_arms
    @weights = Array.new(num_arms, 1.0)

    # Optimal gamma when horizon T is known
    @gamma = gamma || if horizon
      [1.0, Math.sqrt(num_arms * Math.log(num_arms) / ((Math::E - 1) * horizon))].min
    else
      0.1  # default; use doubling trick if T unknown
    end
  end

  def select_arm
    total_weight = @weights.sum
    @probabilities = @weights.map do |w|
      (1.0 - @gamma) * w / total_weight + @gamma / @num_arms
    end

    # Sample arm from probability distribution
    sample_from_distribution(@probabilities)
  end

  def update(arm, reward)
    # Importance-weighted reward estimate
    # Corrects for the fact that we only observe the chosen arm
    estimated_reward = reward / @probabilities[arm]

    # Exponential weight update
    @weights[arm] *= Math.exp(@gamma * estimated_reward / @num_arms)
  end

  private

  def sample_from_distribution(probs)
    r = rand
    cumulative = 0.0
    probs.each_with_index do |p, i|
      cumulative += p
      return i if r <= cumulative
    end
    probs.length - 1  # safety fallback for floating-point edge case
  end
end
```

#### Numerically Stable Variant

```ruby
class EXP3Stable
  # Maintain log-weights to prevent overflow
  def initialize(num_arms, gamma: 0.1)
    @num_arms = num_arms
    @gamma = gamma
    @log_weights = Array.new(num_arms, 0.0)
  end

  def select_arm
    # Log-sum-exp trick for numerical stability
    max_log_w = @log_weights.max
    shifted = @log_weights.map { |lw| Math.exp(lw - max_log_w) }
    total = shifted.sum

    @probabilities = shifted.map do |s|
      (1.0 - @gamma) * s / total + @gamma / @num_arms
    end

    sample_from_distribution(@probabilities)
  end

  def update(arm, reward)
    estimated_reward = reward / @probabilities[arm]
    @log_weights[arm] += @gamma * estimated_reward / @num_arms
  end
end
```

### Variants

- **EXP3-IX (Implicit Exploration)**: modified estimator with gamma in denominator,
  achieves high-probability bounds.
- **EXP3.P**: explicit uniform mixing plus biased loss estimators, provides
  high-probability bounds.
- **EXP3.S**: designed for switching environments where the best arm changes over time.

### Key Properties

| Property | Value |
|---|---|
| Regret | O(sqrt(TK log K)), nearly matches minimax lower bound Omega(sqrt(TK)) |
| Hyperparameters | gamma (exploration); optimal requires knowing horizon T |
| Exploration style | Probabilistic (weight-based) |
| Computational cost | O(K) per step |
| Memory | O(K) |
| Implementation difficulty | Easy, but numerical stability requires care |

### Common Pitfalls

- **Weight explosion** — without normalization or log-space computation, weights grow
  exponentially and overflow. SMPyBandits has defensive code that resets to uniform when
  weights become non-finite. Fix: use the log-sum-exp variant above.
- **Missing importance weighting** — using raw reward instead of reward / P(chosen_arm).
  This biases estimates: low-probability arms are systematically underestimated.
- **Gamma too high** — wastes exploration budget on uniform sampling. Gamma too low —
  probability collapse onto a single arm with insufficient exploration.
- **Using EXP3 in stochastic settings** — it works but is suboptimal by design. Use UCB
  or Thompson Sampling for stochastic rewards.

---

## Bayesian UCB (Bayes-UCB)

### Intuition

Like UCB1 but uses a posterior distribution's quantile as the upper confidence bound
instead of Hoeffding's inequality. More principled when you have a prior. Selection is
deterministic — unlike Thompson Sampling which samples from the posterior, Bayesian UCB
takes a fixed quantile.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| You have a good prior and want deterministic exploration | Feedback is heavily delayed (deterministic selection repeats suboptimal choices with stale posteriors) |
| You want Bayesian flavor without the stochasticity of Thompson Sampling | Posterior computation is intractable |
| You need reproducible arm selections given the same state | You cannot tune the c parameter or want a zero-tuning approach |

### Pseudocode — Beta-Bernoulli

```ruby
class BayesianUCB
  def initialize(num_arms, c: 5)
    @c = c
    # Prior: Beta(1, 1) for each arm
    @successes = Array.new(num_arms, 0)
    @failures  = Array.new(num_arms, 0)
  end

  def select_arm(round)
    # Kaufmann et al. 2012: quantile level = 1 - 1 / (t * log^c(t))
    t = [round, 2].max  # avoid log(1) = 0
    quantile_level = 1.0 - 1.0 / (t * (Math.log(t) ** @c))

    ucb_values = (0...@successes.length).map do |arm|
      alpha = 1.0 + @successes[arm]
      beta  = 1.0 + @failures[arm]
      BetaDistribution.quantile(quantile_level, alpha, beta)
    end

    # Random tie-breaking
    max_ucb = ucb_values.max
    best_arms = ucb_values.each_index.select do |i|
      ucb_values[i] == max_ucb
    end
    best_arms.sample
  end

  def update(arm, reward)
    # reward is 0 or 1
    @successes[arm] += reward
    @failures[arm]  += (1.0 - reward)
  end
end
```

#### Gaussian Variant

```ruby
class BayesianUCBGaussian
  def initialize(num_arms, c: 5, prior_mu: 0.0, prior_sigma: 1.0)
    @c = c
    @mu    = Array.new(num_arms, prior_mu)
    @sigma = Array.new(num_arms, prior_sigma)
    @counts = Array.new(num_arms, 0)
  end

  def select_arm(round)
    t = [round, 2].max
    quantile_level = 1.0 - 1.0 / (t * (Math.log(t) ** @c))
    z_score = NormalDistribution.inverse_cdf(quantile_level)

    ucb_values = @mu.each_index.map do |i|
      @mu[i] + @sigma[i] * z_score
    end

    max_ucb = ucb_values.max
    best_arms = ucb_values.each_index.select do |i|
      ucb_values[i] == max_ucb
    end
    best_arms.sample
  end
end
```

#### Simplified Production Form

Some libraries (MABWiser, LeDoux) use a simpler parametric approximation:

```ruby
# Not the formal Bayes-UCB — different theoretical guarantees
ucb = mean + scale * std / Math.sqrt(count)
```

This replaces the posterior quantile with a parametric confidence interval. Easier to
implement but the connection to Bayesian optimality is lost.

### Key Properties

| Property | Value |
|---|---|
| Regret | Asymptotically optimal for binary bandits (Kaufmann et al. 2012) |
| Hyperparameters | c parameter (c=5 recommended for proven optimality) |
| Exploration style | Deterministic |
| Computational cost | O(K) — quantile function evaluation per arm |
| Memory | O(K) — posterior parameters per arm |
| Implementation difficulty | Easy (requires quantile function for chosen distribution) |

### Bayes-UCB vs Thompson Sampling

Both are asymptotically optimal and both use posterior information. Key differences:

| Property | Bayes-UCB | Thompson Sampling |
|---|---|---|
| Selection | Deterministic (quantile) | Stochastic (sample) |
| Delayed feedback | Degrades (repeats choices) | Robust (stochastic diversity) |
| Tuning | c parameter | Prior parameters (often none) |
| Reproducibility | Same state always gives same arm | Same state gives different arms |

### Common Pitfalls

- **Wrong quantile direction** — must use 1 - 1/t (upper bound), not 1/t (lower bound).
  The upper quantile is what provides optimism.
- **Ignoring the c parameter** — c=0 is the simplest form but slightly too aggressive.
  Kaufmann et al. recommend c=5 for proven optimality guarantees.
- **Conflating formal and simplified forms** — the posterior quantile form and the
  mean + scale * std / sqrt(n) form have different theoretical guarantees. Know which one
  you are implementing.

---

## Softmax / Boltzmann Exploration

### Intuition

Select arms with probability proportional to their estimated value, controlled by a
temperature parameter. High temperature approaches uniform random. Low temperature
approaches greedy. Unlike epsilon-greedy which explores all arms equally, Softmax explores
better-looking arms more often.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| Arm values are meaningfully different and you want proportional exploration | You need theoretical regret guarantees (use UCB or TS) |
| You need smooth probability distributions (gradient-based optimization) | Rewards are on arbitrary scales (temperature interpretation changes) |
| Common in deep RL as an action selection mechanism | You want exploration independent of value estimates |

### Pseudocode

```ruby
class SoftmaxBandit
  def initialize(num_arms, tau: 1.0, anneal: :logarithmic)
    @num_arms = num_arms
    @tau_initial = tau
    @anneal = anneal
    @counts = Array.new(num_arms, 0)
    @values = Array.new(num_arms, 0.0)
    @total_rounds = 0
  end

  def select_arm
    @total_rounds += 1
    tau = annealed_temperature

    # Log-sum-exp trick for numerical stability
    logits = @values.map { |q| q / tau }
    max_logit = logits.max
    shifted = logits.map { |l| Math.exp(l - max_logit) }
    total = shifted.sum

    probabilities = shifted.map { |s| s / total }
    sample_from_distribution(probabilities)
  end

  def update(arm, reward)
    @counts[arm] += 1
    # Incremental mean update
    @values[arm] += (reward - @values[arm]) / @counts[arm]
  end

  private

  def annealed_temperature
    t = @total_rounds
    case @anneal
    when :logarithmic
      # Prevents log(0); decays slowly
      1.0 / Math.log(t + 1e-7)
    when :linear
      tau_min = 0.01
      decay_rate = @tau_initial / 10_000.0
      [tau_min, @tau_initial - decay_rate * t].max
    when :exponential
      decay = 0.999
      @tau_initial * (decay ** t)
    when :constant
      @tau_initial
    end
  end

  def sample_from_distribution(probs)
    r = rand
    cumulative = 0.0
    probs.each_with_index do |p, i|
      cumulative += p
      return i if r <= cumulative
    end
    probs.length - 1
  end
end
```

### Key Properties

| Property | Value |
|---|---|
| Regret | Linear without annealing; sublinear with proper annealing |
| Hyperparameters | Temperature tau (and annealing schedule) |
| Exploration style | Probabilistic (value-proportional) |
| Computational cost | O(K) per step |
| Memory | O(K) |
| Implementation difficulty | Easy, but temperature tuning is problem-dependent |

### Common Pitfalls

- **Overflow in exp()** — without log-sum-exp trick, large Q/tau values cause NaN or Inf.
  Always subtract the max logit before exponentiating.
- **Temperature scale dependence** — tau=1 means very different things for rewards in
  [0, 1] vs rewards in [0, 1000]. Temperature must be calibrated to the reward scale.
- **No annealing** — constant temperature gives linear regret. The algorithm never
  converges to the best arm.
- **Aggressive annealing** — locks onto a suboptimal arm before sufficient exploration.
  If temperature drops too fast, early noisy estimates become permanent.

---

## Cross-Cutting: How Tier 2 Extends Tier 1

### Interface Change

Tier 1 algorithms share `select_arm` with no arguments. Contextual algorithms (LinUCB)
extend this to `select_arm(context)`. Per-arm state grows from scalars to matrices.

```ruby
# Tier 1 interface
select_arm          # no context
update(arm, reward)

# Tier 2 contextual interface
select_arm(context)           # context is a feature vector
update(arm, context, reward)  # context needed for model update
```

### Context Handling Patterns

```ruby
# Raw features are often too high-dimensional.
# Production systems compress aggressively.

# PCA reduction (Yahoo: 1,200 features -> 5)
context = PCA.transform(raw_features, num_components: 5)

# Cluster-based (Deezer: 100 clusters beat 97-dim vectors)
cluster_id = ClusterModel.predict(user_features)
context = one_hot(cluster_id, num_clusters: 100)

# Hierarchical warm-start (Doordash)
# global prior -> cluster prior -> individual posterior
prior = merge(global_prior, cluster_prior(user_cluster))
```

### Offline Evaluation Methods

For evaluating new policies from logged data without running live experiments:

```ruby
# 1. Replay method: accept only when new policy matches historical action
# Simple but discards most data
accepted = log_data.select do |event|
  new_policy.select_arm(event.context) == event.action
end
estimate = accepted.map(&:reward).mean

# 2. Inverse Propensity Scoring (IPS): unbiased but high variance
# V_hat = (1/n) * sum(pi(a|x) / pi_0(a|x) * r)
estimate = log_data.map do |event|
  new_prob = new_policy.probability(event.action, event.context)
  old_prob = event.logging_probability
  new_prob / old_prob * event.reward
end.mean

# 3. Doubly Robust: combines reward model with IPS correction
# Consistent if either the reward model or propensity model is correct
# Default in Vowpal Wabbit
estimate = log_data.map do |event|
  reward_hat = reward_model.predict(event.context, event.action)
  new_prob = new_policy.probability(event.action, event.context)
  old_prob = event.logging_probability
  correction = new_prob / old_prob * (event.reward - reward_hat)
  reward_hat + correction
end.mean
```

### Cold-Start Strategies at Tier 2

| Strategy | Example | Mechanism |
|---|---|---|
| Hierarchical warm-start | Doordash | Regional -> subregional -> user priors |
| Pessimistic initialization | Deezer | Beta(1, 99) reflecting realistic low CTR |
| Feature transfer | Yahoo hybrid LinUCB | Shared parameters transfer across new arms |
| Random exploration bucket | Yahoo, Twitter | 1-5% traffic reserved for unbiased data collection |

### Algorithm Comparison

| Property | LinUCB | EXP3 | Bayesian UCB | Softmax |
|---|---|---|---|---|
| Reward model | Stochastic, linear | Adversarial | Stochastic | Stochastic |
| Context | Yes (features) | No | No | No |
| Exploration | Deterministic | Probabilistic | Deterministic | Probabilistic |
| Regret | O(d sqrt(T log T)) | O(sqrt(TK log K)) | Asymptotically optimal | Linear (constant tau) |
| Memory | O(K d^2) | O(K) | O(K) | O(K) |
| Tuning | alpha, features | gamma | c parameter | tau, annealing |
| Delayed feedback | Degrades | Robust | Degrades | Moderate |

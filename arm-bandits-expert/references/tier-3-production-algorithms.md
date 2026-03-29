# Tier 3: Production-Scale Algorithms

Advanced algorithms for settings where tier 1/2 assumptions break down: non-linear
reward models, combinatorial action spaces, non-stationary environments, evolving arm
states, and partial monitoring. Maturity varies widely — some are research-only, others
have real production deployments.

---

## Neural Bandits

### Intuition

Replace LinUCB's linear reward model with a neural network. Use the network's uncertainty
(via gradients or last-layer Bayesian inference) for exploration. The key finding from
Riquelme et al. 2018 ("Deep Bayesian Bandits Showdown"): last-layer Bayesian linear
regression on neural representations was the most robust and easiest to tune. Dropout,
bootstrapping, and Bayes by Backprop were inconsistent. Complexity of the uncertainty
method did NOT correlate with performance.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| Reward is a non-linear function of context features | A linear model (LinUCB) fits well enough |
| You have enough data to train a neural network | You have fewer than ~10K observations |
| You can afford periodic retraining infrastructure | You need a fully online, single-pass algorithm |
| Feature interactions matter and are hard to engineer by hand | Interpretability is a hard requirement |

### Two Main Algorithms

**NeuralUCB** (Zhou et al. 2020):

```
UCB(a, t) = f(context, a; theta) + beta * sqrt(g^T * Sigma_inv * g)
```

- `f(context, a; theta)` — neural network prediction
- `g` — gradient of the prediction with respect to network parameters
- `Sigma_inv` — inverse of the gradient covariance matrix
- `beta` — exploration coefficient

**NeuralTS** (Zhang et al. 2021):

```
sample ~ Normal(f(context, a; theta), nu^2 * g^T * Sigma_inv * g)
```

Same idea, but Thompson Sampling instead of UCB — sample from a distribution centered on
the prediction, with variance derived from gradient uncertainty.

### Pseudocode — Last-Layer Bayesian Neural Bandit

The practical approach. Train a neural network, then do Bayesian linear regression on the
last hidden layer's representations only.

```ruby
class LastLayerBayesianBandit
  def initialize(num_arms, hidden_dim:, learning_rate: 0.001, retrain_every: 100)
    @network = NeuralNetwork.new(hidden_dim: hidden_dim)
    @retrain_every = retrain_every
    @replay_buffer = []
    @step = 0

    # Bayesian linear regression on last-layer features
    # One set of parameters per arm
    @precision = Array.new(num_arms) do
      IdentityMatrix.new(hidden_dim)  # Sigma_inv = I (prior)
    end
    @theta = Array.new(num_arms) do
      ZeroVector.new(hidden_dim)
    end
    @b = Array.new(num_arms) do
      ZeroVector.new(hidden_dim)
    end
  end

  def select_arm(context)
    features = @network.extract_last_layer(context)

    samples = @theta.each_index.map do |a|
      # Posterior mean and variance from Bayesian linear regression
      mu = features.dot(@theta[a])
      sigma = Math.sqrt(features.dot(@precision[a].solve(features)))

      # Thompson sample
      NormalDistribution.sample(mu, sigma)
    end

    max_sample = samples.max
    best_arms = samples.each_index.select do |i|
      samples[i] == max_sample
    end
    best_arms.sample
  end

  def update(arm, reward, context)
    @replay_buffer.push({ context: context, arm: arm, reward: reward })
    @step += 1

    # Update Bayesian linear regression (cheap, per-step)
    features = @network.extract_last_layer(context)
    # Sherman-Morrison rank-1 update for Sigma_inv
    @precision[arm] = sherman_morrison_update(@precision[arm], features)
    @b[arm] = @b[arm] + features * reward
    @theta[arm] = @precision[arm].solve(@b[arm])

    # Periodic neural network retraining (expensive, batched)
    if @step % @retrain_every == 0
      retrain_network
      reset_bayesian_heads  # re-extract features, refit linear heads
    end
  end

  private

  def sherman_morrison_update(sigma_inv, x)
    # O(d^2) update instead of O(d^3) inversion
    # (A + xx^T)^{-1} = A^{-1} - A^{-1}xx^T A^{-1} / (1 + x^T A^{-1} x)
    a_inv_x = sigma_inv.dot(x)
    sigma_inv - a_inv_x.outer(a_inv_x) / (1.0 + x.dot(a_inv_x))
  end

  def retrain_network
    @network.train_on(@replay_buffer)
  end

  def reset_bayesian_heads
    # Re-extract features with updated network, refit linear regression
    @precision.each_index do |a|
      @precision[a] = IdentityMatrix.new(@precision[a].size)
      @b[a] = ZeroVector.new(@b[a].size)
    end
    @replay_buffer.each do |sample|
      features = @network.extract_last_layer(sample[:context])
      if sample[:arm] == a
        @precision[a] = sherman_morrison_update(@precision[a], features)
        @b[a] = @b[a] + features * sample[:reward]
      end
    end
    @theta.each_index do |a|
      @theta[a] = @precision[a].solve(@b[a])
    end
  end
end
```

### Training Patterns

Three approaches in order of production-readiness:

```ruby
# 1. Online per-step (research only — can be unstable)
network.train_step(context, reward)

# 2. Periodic batch retraining every L steps (avoids catastrophic forgetting)
if step % retrain_interval == 0
  network.train_on(replay_buffer)
end

# 3. Replay buffer + mini-batch SGD (most production-oriented, used by AgileRL)
replay_buffer.push(transition)
if replay_buffer.size >= batch_size
  batch = replay_buffer.sample(batch_size)
  network.train_on_batch(batch)
end
```

### Key Properties

| Property | Value |
|---|---|
| Regret | O(sqrt(T) * poly(d)) under regularity conditions |
| Hyperparameters | Network architecture, learning rate, retrain interval, beta/nu |
| Exploration style | UCB (NeuralUCB) or Thompson (NeuralTS) |
| Computational cost | High — neural network forward/backward pass per step |
| Memory | O(d^2) for last-layer Bayesian; O(p^2) for full gradient (impractical) |
| Implementation difficulty | Moderate (last-layer); Hard (full gradient) |

### Scalability

- **Full gradient covariance**: O(p^2) where p = total network parameters. Impractical for
  large networks.
- **Last-layer Bayesian**: O(d^2) where d = last hidden layer dimension. Tractable.
- **Sherman-Morrison updates**: O(d^2) per step for the precision matrix, avoiding O(d^3)
  matrix inversion.

### Production Evidence

- **Meta ENR** (CIKM 2023): 9%+ CTR improvement over production baselines. Orders of
  magnitude cheaper than baseline neural bandits. Most production-validated neural bandit.
- **AgileRL**: production-ready framework with replay buffer training and neural bandit
  implementations.

### Common Pitfalls

- **Catastrophic forgetting** — retraining the network on new data can destroy previously
  learned representations. Use replay buffers, not just recent data.
- **Gradient covariance scaling** — full gradient covariance is O(p^2) in total network
  parameters. Always use last-layer Bayesian in practice.
- **Hyperparameter sensitivity** — exploration coefficient (beta/nu), retrain frequency,
  and network architecture all interact. Start with the last-layer approach and tune
  conservatively.
- **Stale features after retraining** — when you retrain the network, the last-layer
  representations change. You must recompute the Bayesian linear regression heads on the
  new features, not carry over the old ones.

### Maturity Assessment

**Research to Early Production.** AgileRL provides a production-ready framework. Meta ENR
(CIKM 2023) is the most production-validated deployment. The last-layer Bayesian approach
from Riquelme et al. is the practical sweet spot. Full NeuralUCB/NeuralTS with gradient
covariance remains largely research-only due to scalability.

---

## Combinatorial Bandits

### Intuition

Instead of selecting one arm per round, select a subset (combination) of arms. The
algorithm separates into two parts: (1) statistical learning to estimate individual arm
rewards, and (2) a combinatorial optimization oracle to select the best subset given
current estimates. The oracle is problem-specific — this is both the power and the
challenge.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| You must select multiple items per round (ad slates, playlists, feature sets) | Selecting one item is sufficient |
| Semi-bandit feedback is available (reward per selected item) | You only observe aggregate reward and cannot decompose it |
| The combinatorial oracle for your problem is tractable | Your optimization problem is NP-hard with no good approximation |
| Individual arm rewards are approximately independent | Strong interactions between arms dominate (consider contextual models instead) |

### Feedback Models

```ruby
# Semi-bandit feedback: observe reward for each selected arm (preferred)
selected_arms = [3, 7, 12]
rewards = { 3 => 0.8, 7 => 0.2, 12 => 0.6 }  # one reward per arm

# Full-bandit feedback: observe only aggregate reward (harder)
selected_arms = [3, 7, 12]
aggregate_reward = 1.6  # no per-arm decomposition
```

Semi-bandit feedback leads to faster learning because you get more information per round.
Prefer it when your system can provide per-item feedback.

### Oracle Types

The oracle is the problem-specific part. You must provide one that fits your domain.

```ruby
# Top-K (m-set): select K arms with highest estimates
# O(n log n) — sort and take top K
def top_k_oracle(estimates, k)
  estimates.each_with_index
    .sort_by { |value, _index| -value }
    .first(k)
    .map { |_value, index| index }
end

# Matching / assignment: bipartite matching
# O(n^3) — Hungarian algorithm
def matching_oracle(estimates_matrix)
  HungarianAlgorithm.solve(estimates_matrix)
end

# Submodular maximization: greedy with (1-1/e) approximation guarantee
def submodular_oracle(ground_set, k, submodular_fn)
  selected = []
  k.times do
    best = ground_set.max_by do |item|
      submodular_fn.marginal_gain(selected, item)
    end
    selected.push(best)
    ground_set.delete(best)
  end
  selected
end
```

### Pseudocode — CUCB (Combinatorial UCB)

```ruby
class CombinatorialUCB
  def initialize(num_base_arms, oracle:, alpha: 2.0)
    @oracle = oracle
    @alpha = alpha
    @counts = Array.new(num_base_arms, 0)
    @values = Array.new(num_base_arms, 0.0)
    @total_rounds = 0
  end

  def select_arms
    @total_rounds += 1

    # Compute UCB for each base arm
    ucb_values = @counts.each_index.map do |i|
      if @counts[i] == 0
        Float::INFINITY  # ensure unplayed arms are selected
      else
        exploration_bonus = Math.sqrt(@alpha * Math.log(@total_rounds) / @counts[i])
        @values[i] + exploration_bonus
      end
    end

    # Feed UCB estimates to the combinatorial oracle
    @oracle.solve(ucb_values)
  end

  def update(arms, rewards)
    # Semi-bandit feedback: update each selected arm individually
    arms.each_with_index do |arm, i|
      @counts[arm] += 1
      @values[arm] += (rewards[i] - @values[arm]) / @counts[arm]
    end
  end
end
```

### Key Properties

| Property | Value |
|---|---|
| Regret | O(sqrt(m * K * T * log T)) where m = arms selected, K = total base arms |
| Hyperparameters | alpha (exploration), oracle-specific parameters |
| Exploration style | UCB on base arms, oracle handles combination |
| Computational cost | Base arm UCB is O(K); oracle cost varies by problem |
| Memory | O(K) — statistics per base arm |
| Implementation difficulty | Easy (base arms) + problem-specific (oracle) |

The key insight: regret scales with the number of base arms, NOT the combinatorial space
of possible subsets.

### Applications

- **Ad placement**: select a slate of ads for a page
- **Recommendation**: select a set of items to display
- **Network routing**: select a set of paths
- **Social influence maximization**: select seed users for a campaign

### Common Pitfalls

- **Assuming arm independence when it does not hold** — CUCB assumes rewards decompose
  across arms. If placing two similar ads together hurts both, this model fails.
- **Intractable oracle** — some combinatorial problems are NP-hard. You need an
  approximation oracle, and the regret bound depends on the approximation ratio.
- **Full-bandit when semi-bandit is available** — always prefer semi-bandit feedback if
  your system can provide it. The regret improvement is substantial.
- **Confusing base arms with super arms** — the learning happens at the base arm level.
  The oracle is just an optimization layer on top.

### Maturity Assessment

**Research.** CombinatorialBandits.jl (Julia) is the most complete open-source
implementation. Few production-ready Python libraries exist. The main challenge: the
oracle is problem-specific, making generic libraries difficult. NeUClust (2024) avoids
NP-hard oracles via clustering but is not yet production-tested. If you need combinatorial
bandits, expect to implement the oracle yourself and wrap a standard bandit algorithm
around it.

---

## Non-Stationary Bandits

### Intuition

Reward distributions change over time. Standard bandit algorithms assume stationarity and
will converge to a previously-optimal arm that is now suboptimal. Non-stationary algorithms
detect or adapt to change by forgetting old data. Three sub-types: piecewise stationary
(abrupt changes), slowly varying (gradual drift), and adversarial (arbitrary changes).

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| Reward distributions shift over time (seasonal trends, user preference drift) | The environment is truly stationary |
| You see previously-good arms degrade in performance | Changes are so rare that a standard algorithm recovers naturally |
| You need to track a moving target | You can retrain the entire model periodically instead |

### Key Insight

These are wrappers around standard algorithms. The windowing, discounting, or
change-point detection logic is the novel part. The base algorithm underneath is standard
UCB or Thompson Sampling. This makes them straightforward to implement.

### Pseudocode — Sliding Window UCB (SW-UCB)

Garivier and Moulines, ALT 2011. Use only the most recent tau observations per arm.

```ruby
class SlidingWindowUCB
  def initialize(num_arms, window_size:, alpha: 2.0)
    @window_size = window_size
    @alpha = alpha
    @num_arms = num_arms
    @history = []  # list of { arm:, reward:, time: }
    @total_rounds = 0
  end

  def select_arm
    @total_rounds += 1

    # Get recent history within the window
    recent = @history.last(@window_size)

    ucb_values = (0...@num_arms).map do |arm|
      arm_history = recent.select { |h| h[:arm] == arm }
      if arm_history.empty?
        Float::INFINITY  # unplayed in window — explore
      else
        mean = arm_history.sum { |h| h[:reward] } / arm_history.size.to_f
        exploration = Math.sqrt(@alpha * Math.log(@total_rounds) / arm_history.size)
        mean + exploration
      end
    end

    max_ucb = ucb_values.max
    best_arms = ucb_values.each_index.select { |i| ucb_values[i] == max_ucb }
    best_arms.sample
  end

  def update(arm, reward)
    @history.push({ arm: arm, reward: reward, time: @total_rounds })
  end
end

# Window size heuristic (Garivier & Moulines):
# tau = 2 * sqrt(T * log(T) / (1 + num_change_points))
```

### Pseudocode — Discounted UCB (D-UCB)

Exponentially downweight older observations instead of using a hard window.

```ruby
class DiscountedUCB
  def initialize(num_arms, gamma: 0.99, alpha: 2.0)
    @gamma = gamma
    @alpha = alpha
    @num_arms = num_arms
    @discounted_counts = Array.new(num_arms, 0.0)
    @discounted_sums   = Array.new(num_arms, 0.0)
    @total_discounted   = 0.0
  end

  def select_arm
    ucb_values = (0...@num_arms).map do |arm|
      if @discounted_counts[arm] < 1e-10
        Float::INFINITY
      else
        mean = @discounted_sums[arm] / @discounted_counts[arm]
        exploration = Math.sqrt(@alpha * Math.log(@total_discounted) / @discounted_counts[arm])
        mean + exploration
      end
    end

    max_ucb = ucb_values.max
    best_arms = ucb_values.each_index.select { |i| ucb_values[i] == max_ucb }
    best_arms.sample
  end

  def update(arm, reward)
    # Discount all existing counts and sums
    @discounted_counts.each_index do |i|
      @discounted_counts[i] *= @gamma
      @discounted_sums[i]   *= @gamma
    end
    @total_discounted = @total_discounted * @gamma + 1.0

    # Add new observation
    @discounted_counts[arm] += 1.0
    @discounted_sums[arm]   += reward
  end
end

# gamma typically 0.95 to 0.99
# Lower gamma = faster forgetting = better for rapidly changing environments
```

### Pseudocode — CUSUM-UCB (Change-Point Detection)

More sophisticated: detect change points explicitly, then reset.

```ruby
class CusumUCB
  def initialize(num_arms, base_algorithm:, threshold: 10.0, window: 50)
    @base = base_algorithm
    @threshold = threshold
    @window = window
    @reward_history = Array.new(num_arms) { [] }
  end

  def select_arm
    @base.select_arm
  end

  def update(arm, reward)
    @base.update(arm, reward)
    @reward_history[arm].push(reward)

    # CUSUM change-point detection
    if detect_change(arm)
      reset_arm(arm)
    end
  end

  private

  def detect_change(arm)
    history = @reward_history[arm]
    return false if history.size < @window

    recent = history.last(@window)
    reference_mean = history[0...-@window].sum / (history.size - @window).to_f

    # Cumulative sum of deviations from reference mean
    cusum_pos = 0.0
    cusum_neg = 0.0
    recent.each do |r|
      cusum_pos = [0.0, cusum_pos + (r - reference_mean)].max
      cusum_neg = [0.0, cusum_neg - (r - reference_mean)].max
      return true if cusum_pos > @threshold or cusum_neg > @threshold
    end

    false
  end

  def reset_arm(arm)
    @reward_history[arm] = []
    @base.reset(arm)  # base algorithm clears statistics for this arm
  end
end
```

### GLR-UCB

Generalized likelihood ratio test + KL-UCB. Outperforms prior state-of-art in SMPyBandits
benchmarks. Supports per-arm restart (reset only the arm where change is detected) or
global restart (reset all arms). Per-arm restart is generally preferred.

### Key Properties

| Property | Value |
|---|---|
| Regret | O(sqrt(change_points * T * log T)) for SW-UCB and D-UCB |
| Hyperparameters | Window size / gamma / threshold (depends on variant) |
| Exploration style | Inherited from base algorithm |
| Computational cost | Low overhead on top of base algorithm |
| Memory | O(K * tau) for windowed; O(K) for discounted |
| Implementation difficulty | Easy — wrappers around standard algorithms |

### Common Pitfalls

- **Window too small** — insufficient data for reliable estimates, high variance.
- **Window too large** — slow to adapt to changes, defeating the purpose.
- **Global restart when per-arm would suffice** — resetting all arms when only one changed
  wastes data. Prefer per-arm restart.
- **Not needed at all** — if your environment changes slowly enough, periodic re-running of
  a standard algorithm may be simpler and equally effective.

### Maturity Assessment

**Well-established.** SMPyBandits implements 10+ non-stationary algorithms including
SW-UCB, D-UCB, CUSUM-UCB, M-UCB, and GLR-UCB. Straightforward to implement as wrappers
around any standard bandit algorithm. The windowed and discounted approaches are simple
enough to add to production systems without a library.

---

## Restless Bandits

### Intuition

Arms evolve even when not played. Each arm has an internal state that transitions according
to a Markov chain — one transition matrix when activated, another when passivated. The
agent has a budget: it can only activate B of K arms per round. The goal is to allocate
this budget optimally across arms whose states are constantly changing.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| Arms have internal state that evolves whether or not you interact | Arms are static until pulled |
| You have a hard budget constraint on simultaneous activations | You can pull any arm at any time |
| The per-arm state transition model is known or learnable | State transitions are too complex to model |
| Problem has a natural "activate B of K" structure | The problem is better modeled as standard or contextual bandits |

### The Whittle Index Policy

Whittle (1988). The key idea: compute an index per arm that represents the subsidy you
would need to be indifferent between activating and not activating that arm. Then activate
the B arms with the highest indices. This decouples the K-arm problem into K independent
single-arm problems.

```ruby
class WhittleIndexPolicy
  def initialize(arms, budget:)
    @arms = arms       # each arm has transition_active, transition_passive matrices
    @budget = budget
  end

  def allocate_budget(states)
    # Compute Whittle index for each arm given its current state
    indices = @arms.each_with_index.map do |arm, i|
      compute_whittle_index(arm, states[i])
    end

    # Activate the B arms with highest indices
    ranked = indices.each_with_index
      .sort_by { |index_value, _arm_id| -index_value }

    active_arms = ranked.first(@budget).map { |_value, arm_id| arm_id }
    active_arms
  end

  def update(new_states)
    # States evolve according to transition matrices
    # The agent observes new states after activation decisions
    # No explicit update needed if transitions are known
  end

  private

  def compute_whittle_index(arm, state)
    # Method depends on problem structure:

    # 1. Closed-form (only for simple 1D-state models)
    #    e.g., for two-state arms: analytic formula from transition probabilities

    # 2. Adaptive-greedy (Nino-Mora): O(K^3) for K states
    #    Iteratively computes indices by solving a sequence of LP relaxations

    # 3. Value iteration: solve the single-arm problem for a range of subsidies
    #    Binary search over subsidy lambda until indifference condition is met
    binary_search_whittle_index(arm, state)
  end

  def binary_search_whittle_index(arm, state)
    lo = -1.0
    hi = 1.0

    100.times do
      mid = (lo + hi) / 2.0
      # Solve single-arm problem: is it better to activate or passivate
      # when receiving subsidy mid for passivating?
      active_value = arm.reward(state) + arm.transition_active[state].expected_future_value
      passive_value = mid + arm.transition_passive[state].expected_future_value

      if active_value > passive_value
        lo = mid   # need higher subsidy for indifference
      else
        hi = mid
      end
    end

    (lo + hi) / 2.0
  end
end
```

### UCWhittle — Online Learning of Whittle Policies

AAAI 2023. For when transition probabilities are unknown. Maintains confidence intervals
around transition probabilities using UCB principles.

```ruby
class UCWhittle
  def initialize(num_arms, num_states:, budget:)
    @budget = budget
    # Track transition counts per arm, per state, per action (active/passive)
    @transition_counts = Array.new(num_arms) do
      Array.new(num_states) do
        { active: Array.new(num_states, 0), passive: Array.new(num_states, 0) }
      end
    end
  end

  def allocate_budget(states)
    # Estimate transition probabilities with optimistic confidence bounds
    optimistic_arms = @transition_counts.each_with_index.map do |arm_counts, i|
      build_optimistic_transitions(arm_counts, states[i])
    end

    # Compute Whittle indices using optimistic transition estimates
    indices = optimistic_arms.each_with_index.map do |arm, i|
      compute_whittle_index(arm, states[i])
    end

    ranked = indices.each_with_index
      .sort_by { |index_value, _arm_id| -index_value }
    ranked.first(@budget).map { |_value, arm_id| arm_id }
  end

  def update(states, actions, new_states)
    states.each_with_index do |state, i|
      action = actions.include?(i) ? :active : :passive
      @transition_counts[i][state][action][new_states[i]] += 1
    end
  end
end
```

### Key Properties

| Property | Value |
|---|---|
| Regret | Near-optimal (within ~4% of optimal in benchmarks) for Whittle index |
| Hyperparameters | Budget B, state/transition model specification |
| Exploration style | Index-based (Whittle) or UCB (UCWhittle) |
| Computational cost | O(K) per round once indices are computed; index computation varies |
| Memory | O(K * S^2) for transition estimates (S = states per arm) |
| Implementation difficulty | Moderate (Whittle index); Hard (learning transitions online) |

### Applications

- **Maternal health** (Armman, India): allocate limited health worker calls across
  pregnant women. Each woman's engagement state evolves. Budget = number of health workers.
- **Food rescue**: allocate volunteer notifications across food donors.
- **Cognitive radio**: allocate spectrum sensing across channels.
- **Network maintenance**: allocate repair budget across degrading infrastructure.

### Common Pitfalls

- **Indexability assumption** — Whittle index only exists if the problem is "indexable"
  (there exists a threshold subsidy where the optimal policy switches from active to
  passive). Not all restless bandit problems are indexable. Verify this for your domain.
- **State space explosion** — if arms have high-dimensional state, the transition model
  becomes intractable. Works best with small, discrete state spaces.
- **Ignoring the passive transition** — arms evolve when NOT played. Failing to model this
  misses the core problem structure.
- **Treating it as a standard bandit** — if arms have internal state, standard bandit
  algorithms that only track reward statistics will miss state-dependent dynamics.

### Maturity Assessment

**Research to Applied.** The Whittle index policy is mathematically well-established and
has real deployments (Armman maternal health). However, computing Whittle indices requires
problem-specific modeling — there is no generic plug-and-play library. UCWhittle (AAAI
2023) addresses the online learning case but remains academic. If your problem has the
right structure (discrete states, known or learnable transitions, budget constraint),
the Whittle index approach is sound.

---

## Cascading Bandits

### Intuition

Model the cascade click model from information retrieval. A user examines a ranked list
of items from top to bottom. They click the first attractive item and stop browsing. Items
before the click are negative feedback (examined but not clicked). Items after the click
are unobserved — the user never saw them. This partial monitoring structure is the
defining feature.

### When to Use / When Not To

| Reach for it when | Avoid it when |
|---|---|
| Users examine items sequentially and stop at the first attractive one | Users examine all items before choosing |
| You observe which position was clicked (or that nothing was clicked) | You have full feedback on all displayed items |
| The cascade click model is a reasonable behavioral assumption | Users click multiple items or re-examine the list |

### Pseudocode — CascadeUCB1

```ruby
class CascadeUCB1
  def initialize(num_items, slate_size:, alpha: 2.0)
    @num_items = num_items
    @slate_size = slate_size
    @alpha = alpha
    @counts = Array.new(num_items, 0)
    @values = Array.new(num_items, 0.0)  # estimated attraction probability
    @total_rounds = 0
  end

  def select_ranking
    @total_rounds += 1

    # Compute UCB for each item's attraction probability
    ucb_values = (0...@num_items).map do |item|
      if @counts[item] == 0
        Float::INFINITY
      else
        exploration = Math.sqrt(@alpha * Math.log(@total_rounds) / @counts[item])
        @values[item] + exploration
      end
    end

    # Rank by UCB score, return top slate_size items
    ucb_values.each_with_index
      .sort_by { |value, _item| -value }
      .first(@slate_size)
      .map { |_value, item| item }
  end

  def update(ranking, click_position)
    # click_position = index within ranking where user clicked
    # nil if user examined all items without clicking

    if click_position.nil?
      # User examined all items, clicked none — all are negative feedback
      ranking.each do |item|
        @counts[item] += 1
        @values[item] += (0.0 - @values[item]) / @counts[item]
      end
    else
      # Items BEFORE click: examined but not attractive (reward = 0)
      ranking[0...click_position].each do |item|
        @counts[item] += 1
        @values[item] += (0.0 - @values[item]) / @counts[item]
      end

      # Clicked item: attractive (reward = 1)
      clicked_item = ranking[click_position]
      @counts[clicked_item] += 1
      @values[clicked_item] += (1.0 - @values[clicked_item]) / @counts[clicked_item]

      # Items AFTER click: NOT updated — user never saw them
      # This is the key property of the cascade model
    end
  end
end
```

### CascadeKL-UCB

Uses KL-divergence bounds instead of Hoeffding bounds. Matches the information-theoretic
lower bound up to a logarithmic factor. Preferred in practice when attraction probabilities
are small (closer to 0 than to 0.5), because KL bounds are tighter than Hoeffding in that
regime.

```ruby
# Replace the UCB computation with KL-UCB:
def kl_ucb(mean, count, total_rounds)
  # Find the largest q such that KL(mean, q) <= log(total_rounds) / count
  # KL(p, q) = p * log(p/q) + (1-p) * log((1-p)/(1-q))  (Bernoulli KL)
  threshold = Math.log(total_rounds) / count
  binary_search_kl_upper_bound(mean, threshold)
end
```

### Key Properties

| Property | Value |
|---|---|
| Regret | O(K * log(T) / gap) where K = total items, NOT number of possible rankings |
| Hyperparameters | alpha (CascadeUCB1), slate size |
| Exploration style | UCB on per-item attraction probabilities |
| Computational cost | O(num_items * log(num_items)) per round (sorting) |
| Memory | O(num_items) — attraction probability per item |
| Implementation difficulty | Easy |

The regret depends on the number of items, not the number of possible rankings. This is
because the cascade structure enables decomposition into per-item learning problems.

### Production Evidence

- **Expedia**: CascadeLinTS for homepage component ranking. Feature-based attraction
  probabilities with Thompson Sampling. Outperformed greedy baseline over 100K+
  interactions.

### Common Pitfalls

- **Updating items after the click** — the user never saw them. Treating unseen items as
  negative feedback biases attraction estimates downward.
- **Ignoring position bias** — the cascade model assumes users always examine from top to
  bottom. If position itself affects click probability (beyond the cascade effect), you
  need a position-bias-aware model.
- **Assuming cascade when users browse fully** — if users examine all items and then choose,
  the cascade model is wrong. Use a standard slate/combinatorial bandit instead.
- **Small slate, many items** — when the slate is much smaller than the item pool, most
  items get very few observations. Consider feature-based (contextual) variants like
  CascadeLinTS for generalization.

### Maturity Assessment

**Research to Early Production.** No standalone open-source library exists. Implementations
are typically custom. However, the algorithm is simple enough (the pseudocode above is
nearly complete) that direct implementation is practical. Expedia's CascadeLinTS deployment
demonstrates production viability. The main gap is tooling, not algorithmic maturity.

---

## Interface Evolution Across Tiers

As problems grow more complex, the bandit interface expands:

| Tier | Interface | Key Addition |
|---|---|---|
| 1 | `select_arm` / `update(arm, reward)` | -- |
| 2 | `select_arm(context)` / `update(arm, reward, context)` | Context features |
| 3 Neural | `select_arm(context)` / `update(arm, reward, context)` | Neural reward model |
| 3 Combinatorial | `select_arms(context)` / `update(arms, rewards, context)` | Oracle + multi-arm |
| 3 Non-stationary | `select_arm` / `update(arm, reward)` | Windowing wrapper |
| 3 Restless | `allocate_budget(states, budget)` / `update(new_states)` | Per-arm state + budget |
| 3 Cascading | `select_ranking` / `update(ranking, click_position)` | Partial monitoring |

Tier 1 and tier 3 non-stationary share the same interface — non-stationary algorithms are
wrappers, not new interfaces. The real interface changes come from combinatorial action
spaces (multi-arm selection), state-dependent arms (restless), and partial monitoring
(cascading).

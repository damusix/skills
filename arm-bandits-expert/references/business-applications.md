# Business Applications of Multi-Armed Bandits

A practitioner's guide to where bandits create business value, which algorithm fits which problem,
and what real companies have measured. Written for product managers, marketing directors, and
technical leaders who need to decide whether bandits are right for their use case.

Every example below traces to a named company deployment or published study. For full evidence
with links, see the corresponding `evidence/biz-*.md` files.

---

## Translating Technical to Business Language

Before diving in, here's a glossary that maps bandit jargon to business concepts:

| Technical Term | Business Translation | Example |
|---|---|---|
| **Arm** | An option or variant being tested | An email subject line, a product thumbnail, a price point |
| **Reward** | The outcome you're optimizing for | Click, purchase, revenue, patient recovery |
| **Regret** | Cumulative opportunity cost of not always picking the best option | Revenue lost by showing suboptimal variants during learning |
| **Exploration** | Testing options you're uncertain about | Showing a new headline to 5% of users to see if it works |
| **Exploitation** | Using what's already proven to work | Showing the best-performing headline to 95% of users |
| **Exploration tax** | The short-term cost of learning | Conversions lost while testing unproven variants |
| **Context** | Information about the current situation | User demographics, time of day, device type |
| **Contextual bandit** | A system that personalizes choices based on context | Showing different thumbnails to different user segments |
| **Cold start** | Having no data about a new option | A new product with zero interaction history |
| **Non-stationarity** | The best option changes over time | Seasonal demand shifts, trending content, competitor moves |
| **Thompson Sampling** | A strategy that balances testing and winning based on probability | The most common production algorithm — used by Netflix, DoorDash, LinkedIn, and most platforms |

---

## Business Decision Framework

Start here. Match your situation to a row and follow the recommendation.

### "What am I trying to optimize?"

| Your Situation | Recommended Approach | Algorithm | Why |
|---|---|---|---|
| Email subject lines or push notifications | Thompson Sampling | `Thompson Sampling (Beta-Bernoulli)` | Binary outcome (open/not), learns fast, shifts volume to winners automatically. Used by Pizza Hut (+30% transactions), Braze, Amplitude. |
| CTA buttons or landing pages (few variants) | Epsilon-greedy | `Epsilon-greedy with decay` | Simplest to implement and explain. Good enough for low-stakes tests with <5 options. Used by VWO, MoMo. |
| Product thumbnails or hero images | Thompson Sampling | `Thompson Sampling (Beta-Bernoulli)` | Click/no-click feedback. Runs independently per product. Used by Netflix (20M+ req/sec), Hotels.com (thousands of properties). |
| Personalized recommendations | Contextual bandits | `LinUCB or contextual Thompson Sampling` | Different users respond to different options — context matters. Used by Yahoo (+12.5% CTR), Spotify, Wayfair, Uber. |
| Homepage layout or carousel ranking | Combinatorial bandits | `Combinatorial Thompson Sampling` | Selecting sets of items for multiple slots simultaneously. Used by Amazon, Deezer, Expedia (CascadeLinTS). |
| Dynamic pricing | Thompson Sampling + constraints | `Thompson Sampling + LP` | Learns demand curves while respecting inventory limits. Used by ZipRecruiter (+84% profit), airBaltic (+6% rev/passenger), Rue La La (~10% revenue). |
| Clinical trial treatment allocation | Bayesian adaptive randomization | `Response-adaptive Thompson Sampling` | Assigns more patients to effective treatments as evidence accumulates. Used by I-SPY 2 (7+ drugs graduated), REMAP-CAP, RECOVERY. |
| Competitive auction bidding | Adversarial bandits | `EXP3 / BatchEXP3` | Competitors change strategies — stochastic assumptions break. Used by Zalando (56% products profitable). |
| Portfolio optimization | Non-stationary bandits | `ADTS (Adaptive Discounted Thompson Sampling)` | Markets shift — standard bandits converge to stale strategies. Bandit Networks showed 20% higher Sharpe ratio. |
| Notification timing with fatigue | Recovering bandits | `Recovering Difference Softmax` | Standard bandits assume stable rewards, but notification effectiveness degrades with repetition. Used by Duolingo (+0.5% DAU). |
| LLM model routing | Contextual bandits | `BaRP (REINFORCE + entropy)` | Balances response quality vs API cost per prompt type. +12.46% over offline routers, 50% cost reduction. |
| Resource allocation under constraints | Restless bandits | `Whittle index policy` | Models resources that change state whether you act or not. ARMMAN SAHELI: 330K+ beneficiaries, 32% fewer engagement drops. |

### "Should I use bandits or A/B testing?"

| Use Bandits When | Stick With A/B Tests When |
|---|---|
| **Many variants (4+)** — Google showed 6-arm bandits complete in 88 days vs 919 days classical | **You need statistical significance** — bandits don't provide p-values or confidence intervals |
| **Short windows** — flash sales, holiday campaigns, trending content | **You're measuring long-term effects** — retention, LTV, or outcomes that take months |
| **Opportunity cost matters** — every visitor on a losing variant is lost revenue | **Fundamental changes** — checkout redesign or pricing structure overhaul deserves controlled experiments |
| **Continuous optimization** — campaigns run indefinitely, preferences shift | **Few variants (2–3)** — A/B testing's opportunity cost is modest |
| **Personalization needed** — contextual bandits match variants to user segments | **Regulatory requirements** — FDA trials, financial compliance, or leadership requires formal proof |
| **Scale** — Hotels.com runs independent bandits for thousands of properties simultaneously | **One-time decision** — choosing a logo once doesn't need continuous optimization |

---

## Domain Guide: Marketing & Experimentation

### The Opportunity

Bandits reduce the "exploration tax" — the cost of showing underperforming variants. In a traditional A/B test, 50% of traffic goes to the losing variant for the entire test. Bandits shift traffic to winners as evidence accumulates.

**Google's simulation:** A 6-arm bandit completed in 88 days (vs 919 days classical) and saved 1,173 conversions that would have been wasted on underperforming variants, with 96.4% accuracy in identifying the winner.

### Key Deployments

| Company | Use Case | Algorithm | Result |
|---|---|---|---|
| Pizza Hut / Braze | Email campaign optimization | Proprietary MAB | +30% transactions, +21% revenue, +10% profit |
| Wayfair (Griffin) | Email communications | Contextual bandits (RL) | −15% unsubscribes, replaced 4 separate ML models |
| Wayfair (WayLift) | Paid media targeting | VW contextual bandits | Millions of daily customer-level targeting decisions |
| Uber | CRM email personalization | LinUCB + XGBoost/SquareCB | Handles 100+ variants (vs 2–3 in A/B), GPT embeddings for content |
| Meta | Cross-platform ad budget allocation | Stochastic bandit + LP | Automated real-time bid adjustment across Facebook/Instagram |
| DoorDash | Experimentation platform | Thompson Sampling | Models treatment effects instead of absolute metrics |
| Stitch Fix | Landing page optimization | Thompson Sampling | Many creative options, limited traffic — bandits chosen specifically for this |

### Platform Adoption

Thompson Sampling is the dominant algorithm across experimentation platforms:

| Platform | Algorithm | Key Feature |
|---|---|---|
| Optimizely | Thompson Sampling + Epsilon-greedy | Contextual MABs for personalization |
| Braze | Thompson Sampling | "Intelligent Selection" with automatic winner detection |
| VWO | Epsilon-greedy + Thompson Sampling | Weight updates at fixed intervals |
| Amplitude | Thompson Sampling | Configurable reallocation (hourly/daily/weekly) |
| LaunchDarkly | Thompson Sampling | Feature flag experimentation with automatic traffic shifting |

### Watch Out For

- **Single-metric blindness:** Bandits optimize one metric ruthlessly. If you optimize CTR, watch unsubscribe rates and brand perception separately.
- **No statistical proof:** Bandits maximize conversions but don't generate p-values. If the board needs proof that B beats A, use A/B testing.
- **Non-stationarity:** Marketing performance shifts with seasons and audience fatigue. DoorDash solved this by modeling treatment effects rather than absolute values.

---

## Domain Guide: E-Commerce & Recommendations

### The Opportunity

E-commerce has a natural explore-exploit tension: recommend items you *know* perform well, or surface new items to discover hidden winners. Bandits handle both simultaneously.

### Key Deployments

| Company | Use Case | Algorithm | Result |
|---|---|---|---|
| Netflix | Artwork personalization | Contextual bandits | 20M+ requests/sec, 130M+ members, significant engagement lift |
| Spotify | Homepage calibration | Epsilon-greedy + contextual bandits | +36.6% podcast impression efficiency, +1.28% total consumption |
| Amazon | Page layout optimization | Multivariate Thompson Sampling | Published "Map of Bandits for E-Commerce" practitioner guide |
| eBay | Dynamic pagination | Linear bandit | Positive site-level impact on purchases, clicks, and ad revenue |
| DoorDash | Cuisine filter personalization | Multi-level Thompson Sampling | Cold-start solved via hierarchical priors (global → country → region → user) |
| Alibaba/Taobao | Mobile recommendations | UBM-LinUCB (position-aware) | +20.2% CTR with position bias correction |
| Yahoo | News article recommendation | LinUCB | +12.5% CTR on 33M+ events — the seminal 2010 deployment |
| Deezer | Playlist carousel personalization | Semi-personalized Thompson Sampling | Cluster-based (100 segments) outperformed full personalization |
| Expedia | Hotel homepage ranking | CascadeLinTS | Handles 15 items × 10 positions (11B+ possible rankings) |
| Twitter/X | Ad recommendations | Deep Bayesian bandits (dropout) | TS outperformed UCB and epsilon-greedy, especially with delayed feedback |

### Key Insight: Semi-Personalization Can Beat Full Personalization

Deezer found that clustering users into 100 segments (semi-personalization) outperformed individual-level personalization. Why? Individual users don't generate enough feedback for the bandit to learn. This is a critical lesson for smaller platforms.

### Cold-Start Strategies

| Strategy | How It Works | Who Uses It |
|---|---|---|
| Hierarchical priors | Borrow from similar users/regions/products | DoorDash (global → country → region → district → user) |
| Embedding pre-selection | Use an embedding model to pre-filter 100 candidates, then explore | Spotify BaRT |
| Pessimistic initialization | Assume new items are bad until proven otherwise (Beta(1,99) prior) | Deezer |
| LLM-generated priors | Use an LLM to generate synthetic preferences for new items | CBLI (RBC Borealis, EMNLP 2024): 14–20% regret reduction |

---

## Domain Guide: Dynamic Pricing & Revenue

### The Opportunity

When you don't know the demand curve for a product, segment, or market, bandits learn optimal prices while earning revenue. The exploration tax is higher than in content (every mispriced item is real money), but the payoff can be dramatic.

### Key Deployments

| Company | Use Case | Algorithm | Result |
|---|---|---|---|
| ZipRecruiter | Subscription pricing | Thompson Sampling + demand curves | +84% profit vs $99 standard price (Marketing Science 2019) |
| airBaltic | Airline seat pricing | Thompson Sampling + Bayesian logistic | +6% revenue per passenger (exceeded 2–3% target) |
| Rue La La | Flash sale pricing | Thompson Sampling + LP constraints | ~10% revenue increase |
| Lyft | Driver-rider matching/pricing | Online RL | $30M+/year incremental revenue, 3% fewer cancellations |
| Uber | Experimentation platform | TS, UCB, Bayesian optimization | 1,000+ concurrent experiments across all apps |
| TCS Research | E-commerce markdown pricing | Contextual bandits (COMP model) | +17.2% sales units, +6.1% margin improvement |
| Zalando | Sponsored search bidding | BatchEXP3 | 56% products profitable; learned to bid less where ROI is negative |

### The Pricing Exploration Tax

Unlike content recommendations, pricing exploration has direct revenue consequences:

- **Too-high price explored:** Lost sale (customer walks away).
- **Too-low price explored:** Money left on the table.
- **Thompson Sampling advantage:** Naturally explores uncertain prices more and exploits known-good prices more, minimizing waste. The ZipRecruiter study showed bandits increased profits 43% *during* the testing month compared to uniform random price exploration.

### Ethical and Regulatory Landscape

Dynamic pricing raises real concerns:

- **Price discrimination:** Customers who discover different people pay different prices feel cheated. This triggers moral outrage and damages trust.
- **EU AI Act:** Algorithmic pricing faces increasing regulatory scrutiny. Fairness-constrained bandits (Chen, Simchi-Levi, Wang — Management Science 2023) explicitly address this.
- **Mitigation:** Set price bounds, disclose algorithmic pricing, monitor for disparate impact across demographics, define reward as profit (not revenue) to avoid convergence on excessive discounting.

---

## Domain Guide: Healthcare & Clinical Trials

### The Opportunity

In healthcare, the exploration tax isn't lost conversions — it's patient welfare. Bandits reduce the number of patients assigned to inferior treatments while maintaining enough statistical rigor for regulatory approval.

### Key Deployments

| Organization | Use Case | Algorithm | Result |
|---|---|---|---|
| ARMMAN SAHELI | Maternal health worker scheduling (India) | Restless bandits (Whittle index) | 330K+ beneficiaries, 32% fewer engagement drops |
| Project Eva (Greece) | COVID-19 border testing allocation | Contextual bandits | 1.85x more infected travelers detected vs random (Nature 2021) |
| I-SPY 2 | Breast cancer treatment allocation | Bayesian adaptive randomization | 7+ drugs graduated; 51% vs 26% pCR in triple-negative patients |
| REMAP-CAP | COVID-19 treatment evaluation (13 countries) | Bayesian adaptive randomization | 10,000+ patients, 18,500 randomizations across 14 treatments |
| RECOVERY | COVID-19 treatment trial (UK) | Adaptive platform design | Identified 4 life-saving drugs; dexamethasone saved 1M+ lives globally |
| STAMPEDE | Prostate cancer (UK, running since 2005) | Multi-arm multi-stage design | Changed clinical practice: docetaxel + hormones now standard of care |
| Oralytics | Oral health mHealth intervention timing | Thompson Sampling contextual bandit | Deployed 2023–2024 in real clinical trial |
| HeartSteps | Physical activity mHealth | Thompson Sampling with pooling | 26% lower regret vs state-of-the-art approaches |

### The Ethical Argument

In a standard clinical trial, equal randomization means 50% of patients receive the inferior treatment for the entire trial. Bandit designs shift allocation toward effective treatments as evidence accumulates. Villar et al. (2015) showed Gittins Index achieved ~18.6% more patient successes — but at a cost: statistical power dropped from 80.9% to 36.4%.

**The practical solution:** Hybrid designs (like I-SPY 2's Bayesian adaptive randomization) balance ethical allocation with adequate statistical power. The FDA's 2019 guidance and 2025 Bayesian draft guidance explicitly support these approaches.

### When Bandits Are Wrong for Healthcare

- **Delayed outcomes** (months/years to observe effect) — bandits can't adapt if they don't have feedback
- **Very rare diseases** (<100 patients total) — not enough data for any adaptive design
- **Regulators unfamiliar with adaptive designs** — requires extensive simulation evidence and early engagement

---

## Domain Guide: Finance & Operations

### The Opportunity

Finance has unique challenges: rewards are non-stationary (markets shift), decisions carry downside risk (not just missed upside), and adversarial actors (competitors, counterparties) break stochastic assumptions. Bandits with risk-awareness and non-stationarity handling address all three.

### Key Deployments

| Organization | Use Case | Algorithm | Result |
|---|---|---|---|
| Bandit Networks (ITA, Brazil) | Portfolio optimization | ADTS/CADTS | 20% higher Sharpe ratio, 168% higher cumulative returns vs CAPM |
| Zalando | Sponsored search auction bidding | BatchEXP3 | 56% products profitable; profitability driven by cost reduction |
| Vanguard | Web experimentation (50M+ clients) | Adaptive Allocation / TS | TS outperformed commercial AA algorithm; MABs best for 4+ variants |
| DP-CMAB (Politecnico di Milano) | Dark pool smart order routing | Combinatorial MAB | Outperformed SOR baselines on real market data (ICAIF 2022) |
| PQ-UCB (supply chain) | Multi-echelon inventory optimization | Priority Queue UCB | Outperformed genetic algorithms and simulated annealing |
| O-RAN load balancing | Telecom traffic distribution | Multi-agent MAB | Improved network sum-rate on real French city traffic data |

### Why Finance Needs Different Algorithms

| Aspect | Marketing/E-Commerce | Finance & Operations |
|---|---|---|
| Reward stationarity | Mostly stable | Highly non-stationary |
| Downside risk | Lost conversions | Lost capital, security breaches |
| Adversarial actors | Rarely | Often (competing traders, bidders) |
| Action space | Small (5–20 variants) | Often combinatorial (portfolio weights) |
| Exploration cost | Suboptimal conversion | Real monetary loss per action |
| Dominant algorithms | Thompson Sampling, LinUCB | ADTS, EXP3, risk-aware UCB |

### Maturity Assessment

- **Mainstream:** Web experimentation at financial firms (Vanguard) — proven, low-risk
- **Production-ready:** Auction bidding (Zalando BatchEXP3), electricity market bidding
- **Promising:** Portfolio optimization, smart order routing, telecom load balancing
- **Early research:** Supply chain inventory, cloud VM security, market making

---

## Domain Guide: Content, Media & Technology

### The Opportunity

Content platforms are the natural home for bandits. Fast feedback (clicks arrive in seconds), large catalogs, low exploration cost (showing the "wrong" article is mildly annoying, not harmful), and meaningful personalization premium make this the most mature application domain.

### Key Deployments

| Company | Use Case | Algorithm | Result |
|---|---|---|---|
| Yahoo | News article recommendation | LinUCB / Thompson Sampling | +12.5% CTR on 33M+ events (seminal 2010 deployment) |
| Netflix | Artwork personalization | Contextual bandits | 20M+ req/sec, 130M+ members |
| Spotify | Homepage calibration | Epsilon-greedy + contextual bandits | +36.6% podcast efficiency, +1.28% consumption |
| Microsoft/MSN | News personalization | VW contextual bandits | +26% clicks on MSN.com (became Azure Personalizer) |
| Duolingo | Push notification optimization | Recovering Difference Softmax | +0.5% DAU, +2% new user retention |
| Swiggy | Smart push notifications | Hierarchical Thompson Sampling | TS outperformed UCB; discovered notification fatigue dynamics |
| LinkedIn | Email marketing | Neural TS + LP solver (BanditLP) | +3.08% revenue, −1.51% unsubscribes |
| VK | Games and stickers recommendation | Thompson Sampling + logistic regression | +8% game installs, +5% sticker revenue |

### Notification Fatigue: A Distinct Sub-Problem

Both Duolingo and Swiggy independently discovered that standard bandits fail for notifications. The "best" notification template loses effectiveness when sent repeatedly — a violation of the stationary reward assumption.

**Solutions:**
- **Recovering bandits** (Duolingo): Model effectiveness degradation with repetition and recovery with rest
- **Sleeping arms** (Duolingo): Some templates are conditionally unavailable based on recent sends
- **Frequency caps as constraints** (LinkedIn BanditLP): LP solver enforces per-user send limits

### LLM + Bandits: The Emerging Frontier

| Application | How It Works | Result |
|---|---|---|
| **LLM Routing (BaRP)** | Bandit selects which LLM to query per prompt, balancing quality vs cost | +12.46% over offline routers, 50% cost reduction |
| **Prompt Optimization (OPTS)** | Thompson Sampling selects prompt engineering strategies | Best overall results in EvoPrompt |
| **Cold-Start via LLM Priors (CBLI)** | LLM generates synthetic preferences to initialize bandit priors | 14–20% regret reduction (EMNLP 2024) |
| **IBM KDD 2024 Tutorial** | Canonical reference for MAB+LLM intersection | Covers prompt-as-arms, reward design, scalability |

### Spotify's Lesson: Separate Personalization from Experimentation

Spotify explicitly does NOT use bandits for experimentation. Bandits are personalization features, evaluated by their separate A/B testing platform (Confidence). This prevents conflating single-metric MAB optimization with rigorous multi-metric experiment evaluation. 58 teams ran 520 experiments on mobile homepage alone in one year.

---

## Cross-Domain Algorithm Quick Reference

Which algorithm for which business problem, with a real example for each:

| Algorithm | Best For | Avoid When | Production Example |
|---|---|---|---|
| **Epsilon-greedy** | Simple baselines, low-stakes tests, high catalog churn | You need directed exploration or theoretical guarantees | MoMo vouchers, VWO, Spotify BaRT |
| **UCB1** | Regulated environments needing audit trails, conservative exploration | Environment is adversarial or non-stationary | Schibsted reranking, Vanguard benchmarking |
| **Thompson Sampling** | Most problems — email, thumbnails, pricing, clinical trials, feature flags | You need deterministic/auditable decisions | Netflix, DoorDash, Pizza Hut, I-SPY 2, LinkedIn, LaunchDarkly |
| **LinUCB** | Personalized recommendations with user/item features | Features are high-dimensional (use neural bandits instead) | Yahoo news (+12.5% CTR), Wayfair WayLift, Uber CRM |
| **EXP3 / BatchEXP3** | Competitive/adversarial environments (auctions, market bidding) | Environment is stochastic (TS or UCB will learn faster) | Zalando auction bidding, electricity market bidding |
| **Contextual Thompson Sampling** | Personalization with Bayesian uncertainty | Feature space is very large; posterior updates are expensive | Spotify calibration, VK games, Playtika |
| **Combinatorial bandits** | Selecting sets of items (layouts, portfolios, routing) | Action space is small enough for standard bandits | Amazon layouts, Expedia ranking, dark pool SOR |
| **Restless bandits (Whittle)** | Resources that change state whether you act or not | Arms are stateless between pulls | ARMMAN SAHELI (330K+ beneficiaries) |
| **Recovering bandits** | Notifications, messages where effectiveness degrades with repetition | Rewards are stationary | Duolingo (+0.5% DAU) |
| **Non-stationary bandits (ADTS, SW-UCB, CD-UCB)** | Markets, server loads, seasonal demand | Environment is stationary (simpler algorithms suffice) | Bandit Networks portfolios, CDN node selection |
| **Neural bandits** | High-dimensional features, deep learning pipelines | You have <10K observations (overfitting risk) | Twitter/X ads (deep Bayesian dropout) |

---

## The Exploration Tax Across Domains

The cost of learning varies dramatically by domain. Understanding this helps set appropriate exploration budgets:

| Domain | Exploration Cost | Typical Budget | Example |
|---|---|---|---|
| Content/media | Low (show a slightly less relevant article) | ε = 0.05–0.10 | Netflix: "regret amortized across 130M members" |
| Marketing/email | Low-medium (suboptimal subject line) | ε = 0.05–0.15 | Google: saved 1,173 conversions per experiment |
| E-commerce | Medium (show wrong product, lose a click) | ε = 0.03–0.10 | eBay: "without exploration, system gets stuck" |
| Pricing | High (every mispriced item = real revenue impact) | Thompson Sampling (self-regulating) | ZipRecruiter: TS increased profits 43% vs random exploration |
| Finance | High (capital at risk per exploration) | Risk-bounded, CVaR constraints | Portfolio: 2% allocation to uncertain assets on $100M = $2M at risk |
| Healthcare | Very high (patient welfare at stake) | Safety-constrained, DSMB oversight | Clinical trials: futility stopping drops bad arms early |

**Rule of thumb:** The higher the exploration cost, the more you need Thompson Sampling (which naturally reduces exploration as uncertainty resolves) over epsilon-greedy (which explores at a fixed rate regardless of what it's learned).

When writing a business recommendation, always discuss the exploration tax for the relevant domain. Quantify it: what percentage of traffic will be "wasted" on exploration, and what is the expected payback period? For e-commerce (ε=0.03-0.10), this typically means 3-10% of impressions serve suboptimal results during learning. Frame this as an investment with expected ROI, not a cost — the exploration period is typically days to weeks, while the exploitation benefit compounds over months.

---

## Common Failure Modes Across All Domains

These failure modes appear repeatedly across deployments. Check each one before launching:

### 1. Optimizing the Wrong Metric
Bandits ruthlessly maximize whatever metric you give them. Optimizing CTR may produce clickbait (Netflix mitigates with engagement quality monitoring). Optimizing revenue may converge on excessive discounting (Bain & Company warns about this in pricing).

**Fix:** Define reward carefully. Monitor guardrail metrics (unsubscribes, returns, satisfaction) that aren't being optimized.

### 2. Ignoring Non-Stationarity
Standard bandits assume rewards don't change. They converge and stop learning, missing seasonal shifts, competitor responses, and audience fatigue.

**Fix:** Use non-stationary variants (ADTS, SW-UCB, CD-UCB) or periodically restart exploration. DoorDash models treatment effects rather than absolute metrics to handle time variation.

### 3. Cold Start Without Hierarchy
New items, new users, or new markets have no history. Naive bandits explore randomly, providing poor initial experiences.

**Fix:** Hierarchical priors (DoorDash: global → regional → individual), embedding pre-selection (Spotify), pessimistic initialization (Deezer), or LLM-generated priors (CBLI).

### 4. Insufficient Traffic
Low-traffic items or properties don't generate enough signal. Hotels.com found inconclusive results for low-traffic properties.

**Fix:** Cluster users (Deezer: 100 segments), pool data across similar items, or set minimum traffic thresholds before bandit takes over.

### 5. Filter Bubbles / Concentration
Bandits converge on winners, narrowing diversity over time. Users get trapped in content or product bubbles.

**Fix:** Forced exploration minimums (Schibsted: 5% random items), content-type constraints (Spotify calibration), multi-stakeholder LP constraints (LinkedIn BanditLP).

### 6. Delayed Feedback
E-commerce users buy days later. Clinical outcomes take months. Financial returns are realized over varying horizons. Stale posteriors cause the bandit to keep exploring after it should have converged.

**Fix:** Thompson Sampling handles delays more gracefully than UCB (Chapelle & Li, 2011). Use surrogate endpoints where possible (I-SPY 2 uses pCR instead of overall survival). Use batch-aware algorithms (Zalando's BatchEXP3 with 2-day attribution window).

### 7. Adversarial Environment with Stochastic Algorithm
Using Thompson Sampling or UCB in a competitive setting (auctions, market making) where opponents adapt to exploit your strategy.

**Fix:** Use EXP3 family (adversarial bandits) when competitors are strategic actors. Zalando and electricity market deployments chose adversarial formulations specifically for this reason.

---

## ROI Evidence Summary

The headline metrics from real deployments, organized by magnitude:

### Revenue & Profit Impact
| Company | Metric | Improvement |
|---|---|---|
| ZipRecruiter | Profit vs standard pricing | +84% |
| Pizza Hut / Braze | Transactions from email | +30% |
| Sigmoid cosmetics | Sales per consultant | +24% |
| Alibaba/Taobao | CTR on mobile recommendations | +20.2% |
| TCS Research | Markdown sales units | +17.2% |
| Yahoo | CTR on news recommendations | +12.5% |
| BaRP (LLM routing) | Quality over offline routers | +12.46% |
| Rue La La | Flash sale revenue | ~+10% |
| Sigmoid cosmetics | Profitability | +8% |
| VK | Game installs | +8% |
| airBaltic | Revenue per passenger | +6% |
| E-commerce (academic) | CVR vs default | +16.1% |
| E-commerce (academic) | CTR vs default | +6.1% |

### Efficiency & Cost Savings
| Company | Metric | Improvement |
|---|---|---|
| BaRP (LLM routing) | Cost vs alternatives | −50% |
| Spotify | Podcast impression efficiency | +36.6% |
| Lyft | Incremental annual revenue | $30M+ |
| LinkedIn | Revenue from email marketing | +3.08% |
| Microsoft/MSN | Clicks on news | +26% |
| Google | Time to identify winner (6-arm) | 88 days vs 919 days (−90%) |
| Wayfair | Customer unsubscribes | −15% |

### Patient Outcomes
| Organization | Metric | Improvement |
|---|---|---|
| RECOVERY | Life-saving drugs identified | 4 (dexamethasone saved 1M+ lives) |
| ARMMAN SAHELI | Engagement drops | −32% |
| Project Eva | Infected travelers detected | 1.85x vs random |
| I-SPY 2 | Pathologic complete response (triple-neg) | 51% vs 26% control |
| Bandit Networks | Sharpe ratio vs best classical | +20% |

---

## Platform & Tool Ecosystem

For teams that want to use bandits without building from scratch:

| Platform | Algorithm | Best For | Status |
|---|---|---|---|
| Optimizely | Thompson Sampling, Contextual MABs | Web experimentation | Active |
| Braze | Thompson Sampling | Marketing messages | Active |
| LaunchDarkly | Thompson Sampling | Feature flag optimization | Active |
| Amplitude | Thompson Sampling | Product experimentation | Active |
| VWO | Epsilon-greedy + Thompson Sampling | Web testing | Active |
| Azure Personalizer | Contextual bandits (VW) | Content personalization | Retiring Oct 2026 |
| Fidelity Mab2Rec | Multiple (via MABWiser) | Recommendation pipelines | Open-source (AAAI 2024) |
| Playtika PyBandits | Thompson Sampling | Game recommendations | Open-source |
| Vowpal Wabbit | Contextual bandits | General-purpose, any domain | Open-source |

---

## Where to Go Next

- **For algorithm pseudocode and implementation details:** See `tier-1-core-algorithms.md` through `tier-3-production-algorithms.md`
- **For experiment harness design:** See `experiment-harness-patterns.md`
- **For production deployment patterns:** See `infrastructure-patterns.md`
- **For full evidence with links for each domain:** See the corresponding `evidence/biz-*.md` files

# Versioning — Discipline & What It Communicates


[`release.md`](release.md) picks the *tooling* that bumps the version (Changesets or release-please). This picks *which* bump and *when*. The version number is the one promise every user reads before upgrading — semver (`MAJOR.MINOR.PATCH`) is the contract that says what a change means.

For a CLI, the "public API" that contract covers is not your source code — it is the surface a user or a script touches:

- **commands and flags** — their names, what they accept
- **output format** — anything a script pipes into `jq`, `grep`, or `awk`
- **exit codes** — anything a script branches on
- **config schema** — files and env vars the CLI reads

A change is *breaking* if an invocation or script that worked yesterday fails (or silently does something different) today. That definition, not "did the code change," is what decides the bump.


## Named schemes

A few versioning styles have names worth knowing — choose one on purpose:

- **SemVer (Semantic Versioning)** — the meaning-based contract this guide assumes. The number says *what changed*: a break, a feature, or a fix.
- **CalVer (Calendar Versioning)** — the number is a date (`2026.06`, `24.04`). It communicates *recency* — is this build current and still supported — not compatibility. Fits CLIs where "how fresh is it" matters more than "what broke": tools tracking a moving external target (scrapers, linters, format converters). Used by Ubuntu, Twisted, youtube-dl. The cost: the number alone never tells a user whether upgrading will break them, so CalVer projects need a *separate, written* compatibility policy.
- **ZeroVer (`0ver`)** — never leaving `0.x`. Less a scheme than the avoidance of one (see the anti-pattern under Decision 1 below).

The rest of this doc is SemVer. Pick CalVer only when calendar recency is the more useful signal — then the bump-type rules (Decision 3) don't apply, but pre-releases (Decision 2) and writing the policy down still do.


## What each number promises

| Bump | semver meaning | What the user does |
|------|----------------|--------------------|
| **PATCH** (`1.4.3 → 1.4.4`) | backward-compatible bug fix | takes it without reading anything |
| **MINOR** (`1.4.3 → 1.5.0`) | new functionality, backward compatible | upgrades freely; maybe skims the changelog for new features |
| **MAJOR** (`1.4.3 → 2.0.0`) | incompatible API change | reads the migration notes *before* upgrading |

The promise only means something if you keep it. A patch that breaks a script teaches users to distrust every patch and pin exact versions — which defeats the point of publishing ranges at all.


## Decision 1 — Are you `0.x` or `1.0`?

The biggest fork, and the one most teams get wrong by drift rather than decision.

### `0.x` — "still shaping the API"

semver item 4: *"Major version zero (0.y.z) is for initial development. Anything MAY change at any time."* In `0.x` the **minor** becomes your breaking signal: `0.2 → 0.3` is the "I broke something" bump, `0.2.3 → 0.2.4` is a patch.

This isn't just convention — npm's range math enforces it (see the constraint below). `0.x` tells users: *"pin closely and read the notes; I'm still moving things."*

### `1.0` — "I'll stand behind this"

semver item 5: *"Version 1.0.0 defines the public API."* After it, every breaking change costs a **major** bump — visible, deliberate, and a signal users can trust. Cut `1.0` when people depend on the CLI in production and you are willing to make that promise.

`1.0` is a **commitment, not a maturity badge**. You do not earn it by adding features; you choose it by deciding breakage will now be loud and rare.

### The anti-pattern: `0.x` forever

Staying in `0.x` indefinitely to dodge the commitment ("ZeroVer") has a real cost: users can't tell an intentional break from an accident, because *every* release is allowed to break under the spec. If real users already depend on the tool, you have the obligations of `1.0` whether or not the number admits it — so cut it.

<constraints>

The `0.x` rule is enforced by how npm resolves caret (`^`) ranges, and the asymmetry surprises people:

- `^1.2.3` → `>=1.2.3 <2.0.0` — auto-takes new **minors and patches**.
- `^0.2.3` → `>=0.2.3 <0.3.0` — auto-takes **patches only**; a `0.3.0` is treated as breaking and is *not* pulled in.
- `^0.0.3` → `>=0.0.3 <0.0.4` — locks to that exact release; every bump is breaking.

So in `0.x`, bumping the **minor** is what actually protects users on caret ranges from a breaking change — bumping only the patch would silently ship the break to them. This is why release-please's `bump-minor-pre-major: true` (see [`release.md`](release.md)) maps a breaking commit to a minor while you're pre-1.0: it keeps the number honest with the range math.

Pre-releases are also excluded from normal ranges by default — `^1.2.3` will **not** match `1.2.4-beta.1`. A beta never sneaks into a plain install; users must opt in explicitly.

</constraints>


## Decision 2 — Pre-releases (`alpha` / `beta` / `rc`), or just ship?

A pre-release is a version published *off the default line* so people can test it without it becoming anyone's automatic upgrade. semver item 9: a pre-release *"indicates that the version is unstable and might not satisfy the intended compatibility requirements."*

| Tag | What it says | Audience |
|-----|--------------|----------|
| `-alpha.N` | incomplete; the API may still move; expect breakage | insiders, you, early adopters |
| `-beta.N` | feature-complete; stabilizing; hunting bugs | wider opt-in testing |
| `-rc.N` | believed shippable; last call for blockers | anyone who wants to pre-flight the release |

Precedence runs in that order (semver item 11.4):

    1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0-rc.1 < 1.0.0

**How users get them:** publish under a separate npm dist-tag named for the channel — e.g. `alpha` — so `npm i my-cli` (which resolves the `latest` tag) is untouched, and only `npm i my-cli@alpha` opts in. Combined with the caret rule above (ranges exclude pre-releases), this is the safety property that makes pre-releases safe to publish: nobody gets one by accident. The mechanics of cutting them — `changeset pre enter alpha`, or a prerelease GitHub release — live in [`release.md`](release.md). The tag is yours to name (`alpha`/`beta`/`rc` track the phase; a rolling `next` is another common choice) — just keep the tag you *publish* under and the one you tell users to *install* identical, or `npm i my-cli@next` silently falls back to `latest` and they never test the pre-release.

**When to bother:** a change big or risky enough that a bad `latest` would actually hurt someone — most often a `1.0` or a major (`2.0`) you want field-tested first. **When not to:** a small CLI with few users. Pre-releases add ceremony (extra tags, channels, a second changelog stream); if a regression just means "publish a patch ten minutes later," skip them and ship normal patches and minors. Most CLIs never need more than that.


## Decision 3 — Which bump is *this* change?

Classify by the CLI's real surface, not by how much code moved.

- **PATCH** — a bug fix that leaves the surface identical: a crash fixed, a wrong result corrected, a typo in `--help`. An *error message* reworded counts as patch (unless it's documented and parsed).
- **MINOR** — a new command, a new optional flag, a new opt-in behavior — where *every* prior invocation still works exactly as before.
- **MAJOR** — you removed or renamed a command or flag, changed a default, changed output a script parses, or changed an **exit code** a script branches on. Also: tightening validation so input that used to pass now errors.

<constraints>

The gray areas, decided by "could a script notice?":

- **Output format** to stdout is API. Reordering JSON keys is usually safe; renaming one, changing a type, or altering human-table columns a script greps is breaking.
- **Exit codes** are API. A new code for a genuinely new failure *condition* that couldn't occur before (say, validation for a new flag) is a minor; reassigning the code of an *existing* path — including giving a failure that used to exit `1` its own dedicated code — is major, because scripts branch on these.
- A **bug fix that changes output** someone might have depended on is a judgment call: if the old behavior was clearly wrong, ship it as a patch and call it out in the changelog; if it's plausibly load-bearing, treat it as breaking.

</constraints>


## The decision matrix

| Situation | Version move | What it tells users |
|-----------|--------------|---------------------|
| Brand-new product, API still moving | start `0.1.0`; bump **minor** on every breaking change (`0.2.0`, `0.3.0`) | "Unstable — pin closely, expect churn between minors." |
| New product, want feedback on a risky design first | `0.x` plus an `-alpha`/`-beta`, under an `alpha` dist-tag | "Experimental, opt-in only — not even the `latest` default." |
| People now depend on it in production | cut `1.0.0` | "Stable contract; breaking changes cost a major from here." |
| Backward-compatible feature on a `1.x` line | **minor** (`1.5.0`) | "New capability, nothing broke — safe upgrade." |
| Bug fix, surface unchanged | **patch** (`1.5.1`) | "Safe. Take it." |
| Breaking change on a stable product | **major** (`2.0.0`) | "Read the migration notes before upgrading." |
| Big/risky change you want field-tested before it's the default | `2.0.0-rc.1` under an `rc` dist-tag | "Preview the next major; `latest` stays put until it's ready." |
| Shipped a major, but users need runway | release `2.0.0` **and** keep patching `1.x` for a window | "Upgrade on your schedule; the old line is still supported for now." |


## Write the policy down

Decide the scheme and the rules once, then record them so no contributor — or your future self — re-derives them from scratch:

- **In prose, in the repo** — a short `## Versioning` section in `README.md` or `CONTRIBUTING.md`: the scheme (SemVer or CalVer), whether you're pre- or post-`1.0`, how breaking changes bump while in `0.x`, and which dist-tag carries pre-releases. A paragraph is enough.
- **In the tooling, where it's enforced** — the choice is already half-encoded in config: release-please's `bump-minor-pre-major: true` *is* the "`0.x` minor = breaking" rule in machine form, and Changesets pre mode *is* the pre-release channel. Keep the config and the prose in agreement — the config enforces, the prose explains the intent a flag can't.

The goal: make the next "is this a minor or a major?" answerable by reading the policy, not by re-litigating it.


## Putting it together

- New product still shaping its surface → start at `0.1.0`, bump the **minor** on breaks, and don't fake a `1.0` you're not ready to honor.
- The moment people depend on it → cut `1.0` and start honoring semver for real; breakage becomes a deliberate, loud major.
- Reserve `alpha`/`beta`/`rc` for changes big enough that a bad default release would hurt — and publish them on a non-`latest` tag so they're strictly opt-in. Otherwise just ship patches and minors.
- Day to day, classify every change by the CLI's real public API — commands, flags, output, exit codes — not by the size of the diff.

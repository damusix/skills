# Members & Subscriptions


## Overview


Ghost's membership system provides free and paid tier access control, inline signup forms, and a Portal overlay for subscription management. All gating is server-enforced — there is no client-side bypass path. The two top-level primitives are the `@member` object (present when a visitor is logged in) and the `access` boolean (calculated per-post based on the viewer's tier versus the post's visibility setting).


## The `@member` Object


`@member` is a global data object available in every template context. When the viewer is not logged in it evaluates to falsy. When logged in, it carries the following properties.

**Identity properties:**

- `@member` — the member object itself; truthy when logged in, falsy otherwise
- `@member.email` — the member's email address
- `@member.name` — the member's full name
- `@member.firstname` — everything before the first whitespace in `name`
- `@member.uuid` — a stable unique identifier, safe for analytics (e.g. Google Tag Manager)
- `@member.paid` — `true` when the member has any active paid subscription (statuses: `active`, `trialing`, `unpaid`, `past_due`); `false` for free members

**Subscription array:**

- `@member.subscriptions` — array of Stripe subscription objects (see Subscription Attributes below)

**Three-state pattern** (the canonical UI branching idiom):

    {{#if @member.paid}}
        <p>Thanks for being a paying member.</p>
    {{else if @member}}
        <p>Thanks for being a free member.</p>
    {{else}}
        <p>Sign up to get access.</p>
    {{/if}}


## Subscription Attributes


Each item in `@member.subscriptions` comes directly from Stripe. Iterate with `{{#foreach @member.subscriptions}}`.

**Subscription-level fields:**

- `id` — Stripe subscription ID
- `status` — one of `active`, `trialing`, `unpaid`, `past_due`, `canceled`
- `start_date` — subscription start date; use with `{{date}}`
- `current_period_end` — paid-through date; use with `{{date}}`
- `cancel_at_period_end` — `true` when canceled but still active until period end
- `default_payment_card_last4` — last four digits of the paying card
- `avatar_image` — Gravatar URL for the customer email; returns a transparent PNG when no Gravatar is set

**Customer sub-object:**

- `customer.id` — Stripe customer ID
- `customer.name` — customer name in Stripe
- `customer.email` — customer email in Stripe

**Plan sub-object:**

- `plan.id` — Stripe price/plan ID
- `plan.nickname` — `Monthly` or `Yearly`
- `plan.interval` — `month` or `year`
- `plan.currency` — ISO currency code (e.g. `USD`)
- `plan.amount` — amount in smallest currency unit (cents for USD); divide by 100 or use `{{price plan}}`

**Tier sub-object:**

- `tier.name` — display name of the Ghost tier (product) this subscription belongs to
- `tier.description` — tier description or `null`

**Offer fields:**

- `offer` — details of the most recent offer redeemed, or `null`
- `offer_redemptions` — array of all offers redeemed over the subscription lifetime
- `offer.display_title` — offer display name
- `offer.display_description` — offer display description
- `offer.type` — `percent`, `fixed`, or `trial`
- `offer.amount` — discount value
- `offer.duration` — `once`, `repeating`, or `forever`
- `offer.cadence` — `monthly` or `yearly`

**`next_payment` sub-object** (present only on active subscriptions; `null` when inactive):

- `next_payment.amount` — next charge amount in smallest currency unit, after discounts
- `next_payment.original_amount` — pre-discount amount
- `next_payment.interval` — `month` or `year`
- `next_payment.currency` — ISO currency code
- `next_payment.discount` — active discount object or `null`

Discount properties (when `next_payment.discount` is not null):

- `discount.end` — date the discount ends, or `null` for forever discounts
- `discount.type` — `percent` or `fixed`
- `discount.amount` — discount value
- `discount.duration` — `once`, `repeating`, or `forever`
- `discount.duration_in_months` — number of months for repeating discounts; `null` otherwise

Always guard `next_payment` with `{{#if}}`:

    {{#foreach @member.subscriptions}}
        {{#if next_payment}}
            <p>Next charge: {{price next_payment}}/{{next_payment.interval}}</p>
        {{/if}}
    {{/foreach}}

Discount display with period end:

    {{#foreach @member.subscriptions}}
        {{#if next_payment.discount}}
            <s>{{price plan}}/{{plan.interval}}</s>
            <p>
                {{price next_payment}}/{{next_payment.interval}}
                {{#if next_payment.discount.end}}
                    — Ends {{date next_payment.discount.end format="D MMM YYYY"}}
                {{else}}
                    — Forever
                {{/if}}
            </p>
        {{else}}
            <p>{{price plan}}/{{plan.interval}}</p>
        {{/if}}
    {{/foreach}}


## Portal Data Attributes


Portal is a JavaScript overlay injected by `{{ghost_head}}` (not `{{ghost_foot}}`). Any element with a `data-portal` attribute becomes a clickable trigger. Portal adds the CSS class `gh-portal-close` to each trigger at initialization, and toggles to `gh-portal-open` when the popup is visible.

**Valid `data-portal` values** (sourced from Portal's `getPageFromLinkPath` router):

- `signup` — opens the signup flow (default plan selection)
- `signup/free` — opens signup pre-selecting the free plan
- `signup/monthly` — opens signup pre-selecting monthly billing
- `signup/yearly` — opens signup pre-selecting yearly billing
- `signup/TIER_ID/monthly` — opens signup pre-filled for a specific tier, monthly price
- `signup/TIER_ID/yearly` — opens signup pre-filled for a specific tier, yearly price
- `signin` — opens the sign-in flow (magic link by default)
- `account` — opens the account home page
- `account/plans` — opens the plan upgrade/change page
- `account/profile` — opens the profile editing page
- `account/newsletters` — opens newsletter preference management
- `account/newsletters/help` — opens the email-receiving FAQ page
- `account/newsletters/disabled` — opens the email suppression FAQ page
- `support` — opens the supporter/tips page
- `support/success` — opens the support success confirmation page
- `support/error` — opens the support error page
- `recommendations` — opens the recommendations page
- `gift` — opens the gift subscription page
- `share` — opens the share page
- `offers/OFFER_CODE` — opens signup with a specific offer pre-applied

**Usage patterns from real themes:**

    {{! Nav header — logged-out state }}
    <a href="#/portal/signin" data-portal="signin">Sign in</a>
    <a href="#/portal/signup" data-portal="signup">Subscribe</a>

    {{! Nav header — logged-in state }}
    <a href="#/portal/account" data-portal="account">Account</a>

    {{! Content CTA — upgrade for existing free member }}
    <button data-portal="account/plans">Upgrade now</button>

    {{! Content CTA — signup for anonymous visitor }}
    <button data-portal="signup">Subscribe now</button>

    {{! Tier-specific checkout }}
    <a href="javascript:" data-portal="signup/TIER_ID/monthly">Monthly plan</a>
    <a href="javascript:" data-portal="signup/TIER_ID/yearly">Yearly plan</a>

The `href="#/portal/..."` pattern is valid as a fallback for non-JS environments. The `href="javascript:"` pattern is equally common and suppresses navigation entirely when Portal handles the click.


## How `{{ghost_head}}` Injects Portal


Portal is loaded by `{{ghost_head}}`, not `{{ghost_foot}}`. Every theme must call `{{ghost_head}}` inside `<head>` and `{{ghost_foot}}` before `</body>`. Ghost evaluates whether Portal should load based on three settings: `members_enabled`, `donations_enabled`, and `recommendations_enabled`. If all three are disabled, the Portal script is omitted entirely.

When Portal is included, Ghost renders a `<script>` tag like:

    <script defer src="https://cdn.jsdelivr.net/.../portal.min.js"
        data-ghost="https://example.com/"
        data-key="CONTENT_API_KEY"
        data-api="https://example.com/ghost/api/content/"
        data-locale="en"
        crossorigin="anonymous">
    </script>

If paid members are enabled, Ghost also injects Stripe.js:

    <script async src="https://js.stripe.com/v3/"></script>

`{{ghost_foot}}` outputs global code injection (from Ghost Admin settings), post-level code injection, and tag-level code injection — but not Portal. A theme that calls only `{{ghost_foot}}` and omits `{{ghost_head}}` will have no Portal functionality.


## Inline Signup Forms


Inline forms use `data-members-*` attributes on standard HTML form elements. Portal intercepts the submit event and handles the entire flow.

**Minimal email-only form:**

    <form data-members-form>
        <input data-members-email type="email" required="true" />
        <button type="submit">Subscribe</button>
    </form>

**With name capture:**

    <form data-members-form>
        <label>Name <input data-members-name /></label>
        <label>Email <input data-members-email type="email" required="true" /></label>
        <button type="submit">Subscribe</button>
    </form>

**With error display:**

    <form data-members-form>
        <input data-members-email type="email" required="true" />
        <p data-members-error></p>
        <button type="submit">Subscribe</button>
    </form>

### Form Type Values


The `data-members-form` attribute accepts an optional value to control the email type sent:

- `data-members-form` (no value) — default flow; sends signup or signin email depending on whether the address is known
- `data-members-form="signup"` — sends a signup email; if the address already exists, sends a signin email instead
- `data-members-form="subscribe"` — sends a subscription email using "subscription" language; falls back to signin for known addresses
- `data-members-form="signin"` — sends a magic link signin email to existing members only

**Additional form attributes:**

- `data-members-autoredirect="false"` — redirects to the publication homepage after login instead of back to the signup page (default is `true`, which returns the member to the page they signed up from)
- `data-members-otc="true"` — on signin forms, adds one-time code support; Portal displays a modal for code entry alongside the magic link option

**Sign-out link:**

    <a href="javascript:" data-members-signout>Sign out</a>

**Billing portal link:**

    <a href="javascript:" data-members-manage-billing>Manage billing &amp; receipts</a>
    {{! Optional return URL after closing billing portal: }}
    <a href="javascript:"
        data-members-manage-billing
        data-members-return="/account/">Manage billing &amp; receipts</a>

**Label tagging at signup:**

    <form data-members-form="subscribe">
        <input data-members-label type="hidden" value="Early Adopters" />
        <input data-members-email type="email" required="true" />
        <button type="submit">Subscribe</button>
    </form>

### CSS Class Lifecycle


Portal adds classes directly to the `<form>` element during submission:

- `.loading` — added immediately on submit while the request is in flight
- `.success` — added when the email was sent successfully
- `.error` — added when the submission failed

Themes use these classes to show/hide inner `<span>` elements:

    <form data-members-form class="loading">
        <button type="submit">
            <span class="default">Subscribe</span>
            <span class="loader"><!-- spinner SVG --></span>
            <span class="success">Email sent. Check your inbox.</span>
        </button>
    </form>

This is a common pattern for a `subscription-box.hbs` partial.

### Newsletter Selection in Forms


By default, signup subscribes the member to the site's default newsletter. To specify newsletters explicitly, add one or more `data-members-newsletter` inputs.

**Hidden (automatic) newsletter selection:**

    <form data-members-form>
        <input data-members-email type="email" required="true" />
        <input data-members-newsletter type="hidden" value="Weekly Digest" />
        <input data-members-newsletter type="hidden" value="Breaking News" />
        <button type="submit">Subscribe</button>
    </form>

**User-selectable newsletters (checkbox):**

    <form data-members-form>
        <input data-members-email type="email" required="true" />
        <label>
            <input data-members-newsletter type="checkbox" value="Weekly Digest" />
            Weekly Digest
        </label>
        <label>
            <input data-members-newsletter type="checkbox" value="Breaking News" />
            Breaking News
        </label>
        <button type="submit">Subscribe</button>
    </form>

**Dynamic newsletter list using `{{get}}`:**

    <form data-members-form>
        <input type="email" required data-members-email />
        {{#get "newsletters"}}
            {{#foreach newsletters}}
                <label>
                    <input type="checkbox" value="{{name}}" data-members-newsletter />
                    {{name}}
                </label>
            {{/foreach}}
        {{/get}}
        <button type="submit">Subscribe</button>
    </form>


## Content Gating Patterns


### The `access` Variable


`access` is available inside `{{#post}}` context. It resolves to `true` when the current viewer's tier meets or exceeds the post's visibility requirement, and `false` otherwise. Use it to swap CTA copy, not to toggle the `{{content}}` helper — `{{content}}` already respects access server-side.

    {{#post}}
        <h1>{{title}}</h1>
        {{#if access}}
            <p>You have full access to this post.</p>
        {{else}}
            <p>Subscribe to read this post in full.</p>
        {{/if}}
        {{content}}
    {{/post}}

When the visitor lacks access, `{{content}}` outputs only the public preview portion of the post (content before the paywall divider) followed by the default CTA block.

### The `visibility` Property


`visibility` is a post-level string with three possible values:

- `public` — accessible to everyone
- `members` — accessible to any logged-in member (free or paid)
- `paid` — accessible only to paid members

Use `visibility` as a CSS class for visual differentiation:

    <article class="post post-access-{{visibility}}">
        <h1>{{title}}</h1>
        {{content}}
    </article>

Or for icon badges:

    <h1>
        {{title}}
        <svg><use xlink:href="#icon-{{visibility}}"></use></svg>
    </h1>

### Filtering Post Lists by Visibility


By default `{{#foreach posts}}` includes all posts regardless of visibility. Pass the `visibility` parameter to filter:

    {{#foreach visibility="paid"}}
        <article>
            <h2><a href="{{url}}">{{title}}</a></h2>
        </article>
    {{/foreach}}

Content is still gated server-side even when a post appears in the list.

### `{{#has visibility="..."}}` — Tier-Aware Gating in CTAs


The `{{#has}}` helper with `visibility` is the idiomatic way to show different messaging in a `content-cta.hbs` partial based on what kind of post triggered the paywall. Three values are recognized:

- `{{#has visibility="paid"}}` — matches posts set to paid-only
- `{{#has visibility="members"}}` — matches posts set to members-only
- `{{#has visibility="tiers"}}` — matches posts locked to one or more specific tiers

Full content-cta.hbs pattern:

    {{{html}}}

    <section class="single-cta-wrapper">
        {{#has visibility="paid"}}
            <h2>This post is for paying subscribers only</h2>
        {{/has}}
        {{#has visibility="members"}}
            <h2>This post is for subscribers only</h2>
        {{/has}}
        {{#has visibility="tiers"}}
            <h2>This post is only for subscribers on the {{tiers}}</h2>
        {{/has}}

        {{#if @member}}
            <button data-portal="account/plans">Upgrade now</button>
        {{else}}
            <button data-portal="signup">Subscribe now</button>
            <a href="javascript:" data-portal="signin">Already have an account? Sign in</a>
        {{/if}}
    </section>

The `{{{html}}}` triple-stash at the top outputs the post's public preview HTML (the free portion before the paywall divider). The CTA section follows below it.

To override the default CTA, create `partials/content-cta.hbs` in your theme. Ghost will use it automatically.


## The `{{tiers}}` Helper


`{{tiers}}` outputs a formatted comma-separated list of the tier names that have access to the current post. It is only meaningful inside `{{#has visibility="tiers"}}` context (or any context where `this.tiers` is populated).

**Default output** (one tier): `Gold tier`

**Default output** (multiple tiers): `Gold, Silver and Bronze tiers`

**Parameters** (all optional, all accept string values):

- `separator` — delimiter between all-but-last items; default `", "`
- `lastSeparator` — delimiter before the last item; default `" and "`
- `prefix` — string prepended to the entire output; default `""`
- `suffix` — appended to the output; default `" tier"` for one item, `" tiers"` for multiple

**Examples:**

    {{! Default: "Gold and Silver tiers" }}
    {{tiers}}

    {{! Custom separator }}
    {{tiers separator=" / " lastSeparator=" / " suffix=""}}

    {{! Used in a sentence }}
    <h2>This post is for {{tiers}} subscribers only</h2>

One approach combines `{{tiers}}` with `{{plural}}` for grammatically correct messaging:

    {{plural tiers.length
        empty=(t "This post is for subscribers only")
        singular=(t "This post is for subscribers on the tier")
        plural=(t "This post is for subscribers on the tiers")
    }} {{tiers lastSeparator=(t " and ") suffix=""}}


## The `{{price}}` Helper


`{{price}}` converts a Stripe amount (in smallest currency unit, e.g. cents) to a human-readable formatted string using `Intl.NumberFormat`.

**Call signatures:**

    {{! Pass a plan object — reads plan.amount and plan.currency }}
    {{price plan}}

    {{! Pass a raw integer with explicit currency }}
    {{price 500 currency="USD"}}

    {{! Pass next_payment object }}
    {{price next_payment}}

**Options (all optional):**

- `currency` — override the currency code (ISO 4217)
- `numberFormat` — `"short"` (default, omits decimal for whole numbers) or `"long"` (always shows decimals)
- `currencyFormat` — `"symbol"` (default, e.g. `$`), `"code"` (e.g. `USD`), or `"name"` (e.g. `US dollars`)
- `locale` — BCP 47 locale string; defaults to the site locale from `@site.locale`

`{{price plan}}` where `plan.amount = 500` and `plan.currency = "USD"` outputs `$5`.

**In subscription context:**

    {{#foreach @member.subscriptions}}
        <p>Plan: {{price plan}}/{{plan.interval}}</p>
        <p>Next: {{price next_payment}}/{{next_payment.interval}}</p>
    {{/foreach}}


## Subscription Status Checks


**Check if the viewer is any kind of member:**

    {{#if @member}}...{{/if}}

**Check if the viewer is a paid member:**

    {{#if @member.paid}}...{{/if}}

**Inspect subscription status directly** (useful for account pages):

    {{#foreach @member.subscriptions}}
        {{#if cancel_at_period_end}}
            <p>Subscription expires {{date current_period_end format="DD MMM YYYY"}}.</p>
        {{else}}
            <p>Next billing date: {{date current_period_end format="DD MMM YYYY"}}.</p>
        {{/if}}
        <p>Card on file: **** **** **** {{default_payment_card_last4}}</p>
        <p>Plan: {{price plan}}/{{plan.interval}}</p>
    {{/foreach}}

**Statuses that make `@member.paid` true:**

- `active`
- `trialing`
- `unpaid`
- `past_due`

**Status that makes `@member.paid` false:**

- `canceled`

To revoke access for members with payment failures, configure Stripe to automatically cancel subscriptions after all retry attempts fail.


## The `{{cancel_link}}` Helper


`{{cancel_link}}` outputs a cancel-or-continue subscription toggle link. It must be used inside `{{#foreach @member.subscriptions}}`.

**Default output:**

    {{#foreach @member.subscriptions}}
        {{cancel_link}}
    {{/foreach}}

Generates:

    <a class="gh-subscription-cancel"
       data-members-cancel-subscription="sub_XXXXX"
       href="javascript:">Cancel subscription</a>
    <span class="gh-error gh-error-subscription-cancel"
          data-members-error></span>

For a previously canceled subscription, `data-members-cancel-subscription` is replaced with `data-members-continue-subscription`.

**Options:**

- `class` — CSS class on the link; default `gh-subscription-cancel`
- `errorClass` — CSS class on the error span; default `gh-error gh-error-subscription-cancel`
- `cancelLabel` — link text for active subscriptions; default `Cancel subscription`
- `continueLabel` — link text for canceled subscriptions; default `Continue subscription`

    {{cancel_link
        class="cancel-link"
        errorClass="cancel-error"
        cancelLabel="Cancel!"
        continueLabel="Keep my subscription"
    }}


## Newsletter Integration


Newsletters are a first-class concept in Ghost, separate from membership tiers. A member may be subscribed to zero or more newsletters independently of their paid status.

**Fetching newsletter list for a dynamic form:**

Use `{{#get "newsletters"}}` to fetch the site's active newsletters, then loop with `{{#foreach newsletters}}` and read `{{name}}`.

    {{#get "newsletters"}}
        {{#foreach newsletters}}
            <label>
                <input type="checkbox" value="{{name}}" data-members-newsletter />
                {{name}}
            </label>
        {{/foreach}}
    {{/get}}

**Subscribing to a specific newsletter at signup:**

Use a hidden input with the newsletter name as the value:

    <form data-members-form="subscribe">
        <input data-members-email type="email" required="true" />
        <input data-members-newsletter type="hidden" value="Weekly Digest" />
        <button type="submit">Subscribe</button>
    </form>

**Multi-newsletter radio/checkbox selection:**

Use `type="radio"` for single-choice or `type="checkbox"` for multi-choice. The member is subscribed only to the checked newsletters.

    <form data-members-form>
        <input data-members-email type="email" required="true" />
        <label>
            <input data-members-newsletter type="radio" name="newsletter" value="Daily Brief" />
            Daily Brief
        </label>
        <label>
            <input data-members-newsletter type="radio" name="newsletter" value="Weekly Digest" />
            Weekly Digest
        </label>
        <button type="submit">Subscribe</button>
    </form>

Newsletter preferences can also be managed post-signup via Portal: `data-portal="account/newsletters"` opens the newsletter management screen directly.


## Complete Gating Decision Tree


The following shows how to combine all gating primitives for a complete post template:

    {{#post}}
        {{! 1. Show the title and public preview always }}
        <h1>{{title}}</h1>

        {{! 2. Render content — Ghost gates the full body server-side.
               If access is false, {{content}} shows only the preview
               plus the content-cta.hbs partial automatically. }}
        {{content}}

        {{! 3. Optional: show upgrade/signin prompt above the fold }}
        {{#unless access}}
            {{#if @member}}
                {{! Free member viewing paid content }}
                <a href="javascript:" data-portal="account/plans">Upgrade your plan</a>
            {{else}}
                {{! Anonymous visitor }}
                <a href="javascript:" data-portal="signup">Subscribe to continue reading</a>
                <a href="javascript:" data-portal="signin">Already a member? Sign in</a>
            {{/if}}
        {{/unless}}
    {{/post}}

**Post access matrix:**

| Post visibility | Anonymous | Free member | Paid member |
|---|---|---|---|
| `public` | full access | full access | full access |
| `members` | blocked | full access | full access |
| `paid` | blocked | blocked | full access |
| specific tier | blocked | blocked (unless on tier) | depends on tier |

# Naming Conventions <!-- omit in toc -->


Everything is `snake_case`. Postgres folds unquoted identifiers to lowercase, so `PascalCase` requires `"DoubleQuoting"` everywhere — abandon it. Underscores separate words and demarcate suffixes; no other separators.

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Why snake\_case](#why-snake_case)
- [Tables](#tables)
- [Columns](#columns)
- [The Prefix Convention](#the-prefix-convention)
- [Views](#views)
- [Procedures](#procedures)
- [Functions](#functions)
- [Trigger Functions and Triggers](#trigger-functions-and-triggers)
- [Domains](#domains)
- [Constraints](#constraints)
- [Indexes](#indexes)
- [Sequences](#sequences)
- [Parameters](#parameters)
- [Forbidden and Discouraged Names](#forbidden-and-discouraged-names)

---

## Why snake_case

    -- PascalCase: every reference must be quoted, forever
    SELECT "Customer"."FullName" FROM "Customer" WHERE "Customer"."CustomerNo" = 1;

    -- snake_case: no quoting, no shouting
    SELECT customer.full_name FROM customer WHERE customer.customer_no = 1;

The PascalCase form is what you get if you ever write `CREATE TABLE "Customer" (...)` — Postgres preserves the case but requires quoting on every reference.

## Tables

Singular noun, snake_case: `account`, `customer`, `order_line`, `audit_log`.

**No plurals.** A table represents an entity type; rows are instances. `customer` not `customers`.

**Subtype tables** prepend the discriminator: `savings_account`, `checking_account` (subtypes of `account`).

**Junction tables** combine the joined entities: `customer_role` (customers ↔ roles).

## Columns

snake_case nouns. Use suffixes to convey type or role:

| Suffix | Meaning | Example |
|--------|---------|---------|
| `_no` | application-managed number key | `customer_no`, `order_no` |
| `_id` | external/UUID identifier | `entrata_id`, `stripe_customer_id` |
| `_at` | timestamp | `created_at`, `finished_at` |
| `_ms` | duration in milliseconds | `duration_ms` |
| `_count` | counter | `attempt_count` |
| `_flag` | boolean (rare; prefer `is_*`) | `verified_flag` |
| `is_*`, `has_*`, `can_*`, `should_*`, `must_*`, `was_*` | boolean predicate | `is_verified`, `has_subscription` |

## The Prefix Convention

Object kind is encoded as a leading prefix so type is visible at the first glance and tab-completion groups by kind:

| Prefix | Kind |
|--------|------|
| `pr_` | procedure (`CALL`-able, owns transactions) |
| `fn_` | function (returns data, runs in caller's transaction) |
| `tg_` | trigger function (called by triggers, never directly) |
| `vw_` | view |
| `mv_` | materialized view |

Tables, columns, domains, constraints, and indexes have **no kind prefix** — they're the primary entities and don't compete with the typed verbs.

## Views

`vw_<role>_<intent>` — lowercase role prefix, snake_case intent:

    vw_manager_team_report
    vw_admin_all_customers
    vw_customer_my_orders
    vw_worker_pending_jobs
    vw_public_homepage_stats   -- when role is everyone

The role segment communicates the intended consumer; the `vw_` prefix flags it as a view at every reference point. Materialized views use `mv_` instead.

## Procedures

`pr_<verb>_<noun>`. PROCEDUREs are invoked with `CALL`, distinguishing them from functions at the call site, and the `pr_` prefix reinforces it in code search and error logs.

| Pattern | Use |
|---------|-----|
| `pr_add_*` | INSERT-only |
| `pr_modify_*` | UPDATE-only |
| `pr_remove_*` | DELETE-only |
| `pr_add_or_modify_*` | UPSERT (`INSERT ... ON CONFLICT`) |
| `pr_transfer_*` | multi-table state change |
| `pr_apply_*` | apply a calculated change to existing data |

Avoid SQL keyword verbs (`create`, `update`, `delete`, `select`, `insert`) — they collide with statement keywords in error logs and grep.

## Functions

`fn_<descriptive>`. The `fn_` prefix distinguishes from procedures, from columns, and from trigger functions (which use `tg_`).

| Pattern | Use |
|---------|-----|
| `fn_find_<entity>` | SELECT, returns one row or NULL |
| `fn_list_<entities>` | SELECT, returns SETOF |
| `fn_next_<scope>_no` | sequence/max-plus-one helper |
| `fn_<entity>_is_<predicate>` | boolean test |
| `fn_assert_<condition>` | guard — raises if condition false |
| `fn_current_<thing>` | derived current value (`fn_current_app_user_id`) |

## Trigger Functions and Triggers

**Trigger function:** `tg_<subject>_<action>`. Always returns `TRIGGER`, never called directly. The `tg_` prefix flags it at the `EXECUTE FUNCTION` call site so you can tell at a glance the trigger is calling a trigger function, not a regular helper.

    tg_savings_account_check_type()
    tg_customer_audit()
    tg_order_status_transition_check()

**Trigger:** `<subject>_<must|cannot>_<predicate>` or `<subject>_<event>` — sentence-like, no prefix needed because triggers are always created with `CREATE TRIGGER` and unambiguous in context.

    CREATE TRIGGER savings_account_must_be_savings_type
        BEFORE INSERT OR UPDATE ON savings_account
        FOR EACH ROW EXECUTE FUNCTION tg_savings_account_check_type();

    CREATE TRIGGER customer_audit
        AFTER INSERT OR UPDATE OR DELETE ON customer
        FOR EACH ROW EXECUTE FUNCTION tg_customer_audit();

The trigger reads as a sentence about what is enforced; the function reads as what work is done.

## Domains

Lowercase noun, snake_case for multi-word: `email`, `api_key`, `account_no`, `ts_now`, `bool_false`.

Generic primitives use a leading word that hints at default behavior:

- `ts_now` — `TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()`
- `bool_false` — `BOOLEAN NOT NULL DEFAULT FALSE`
- `int_zero` — `INTEGER NOT NULL DEFAULT 0`

Avoid an leading-underscore names (`_timestamp`) — Postgres tooling sometimes treats leading-underscore names specially.

## Constraints

`<subject>_<relationship>_<object>` — reads as a sentence:

    customer_rents_vehicle               -- FK
    savings_account_is_account           -- FK (subtype to base)
    customer_must_have_valid_email       -- CHECK
    customer_email_is_unique             -- UNIQUE
    order_total_is_positive              -- CHECK

Avoid mechanism-named constraints (`fk_customer_vehicle`, `chk_email`) — they describe *how*, not *what*. When a constraint violation appears in an error log, the predicate name tells you the business rule that was broken.

## Indexes

`<table>_<columns>_<kind>_idx`:

    customer_email_idx                          -- B-tree on (email)
    order_customer_no_status_idx                -- composite
    notification_queue_claim_idx                -- partial (named for purpose)
    customer_full_name_gin_idx                  -- GIN (full-text)
    geo_location_gist_idx                       -- GiST (spatial)

Name the *purpose* if a partial index serves one (e.g., `_claim_idx` for the queue partial index).

## Sequences

When you use sequences (instead of max-plus-one), name them `<table>_<column>_seq`:

    CREATE SEQUENCE order_order_no_seq;

Postgres generates this name automatically for `BIGSERIAL` columns; only name explicitly when you create them manually for per-parent scoping.

## Parameters

Procedure/function parameters prefix with `p_` to distinguish from columns:

    CREATE PROCEDURE pr_add_customer(
        p_email     email,
        p_full_name full_name,
        p_role      role_name DEFAULT 'standard'
    ) ...

Local variables prefix with `v_`:

    DECLARE
        v_customer_no customer_no;
        v_now timestamptz := clock_timestamp();

This prevents the dreaded "ambiguous column reference" error inside PL/pgSQL bodies where parameter and column share a name.

## Forbidden and Discouraged Names

**Forbidden:**

- Reserved keywords (`order`, `user`, `from`, `select`, `table`, `column`) — Postgres allows them quoted but you'll regret it. Use `orders`, `app_user`, etc.
- Mixed case (`OrderLine`) — forces quoting forever.
- Spaces or special chars in identifiers — quoting hell.

**Discouraged:**

- Abbreviations beyond universally understood (`no` for Number, `id` for identifier, `qty` for quantity). Otherwise spell it out — `cust`, `prod`, `desc` save typing but cost reading.
- Leading underscore (`_internal`) — some tools treat these as system objects.
- Trailing numbers (`customer2`, `order_v3`) — version suffixes belong in migration filenames or schemas, not table names.

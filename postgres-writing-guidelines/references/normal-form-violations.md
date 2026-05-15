# Normal Form Violations


Normal Forms describe the standards a correctly designed schema must meet. Violations produce update anomalies, data duplication, broken join paths, and constraints that exist only in application code. The patterns below catalog the violations we see most in Postgres apps — what they look like, why they're wrong, and how to fix.

## Table of Contents

- [The Relational Breach (Surrogate PK on a Child Table)](#the-relational-breach-surrogate-pk-on-a-child-table)
- [Repeating Groups (1NF Violation)](#repeating-groups-1nf-violation)
- [Partial Dependency (2NF Violation)](#partial-dependency-2nf-violation)
- [Transitive Dependency (3NF Violation)](#transitive-dependency-3nf-violation)
- [Polymorphic Columns](#polymorphic-columns)
- [Plural Table Names](#plural-table-names)
- [Floating Tables (No Clear Parent)](#floating-tables-no-clear-parent)
- [JSONB as a Schema Substitute](#jsonb-as-a-schema-substitute)

---

## The Relational Breach (Surrogate PK on a Child Table)

The most damaging violation in practice. A child table with a `BIGSERIAL`/`IDENTITY` surrogate PK instead of a composite key including the parent's PK.

**Wrong:**

    CREATE TABLE order_line (
        order_line_id bigserial PRIMARY KEY,
        order_id      bigint NOT NULL REFERENCES orders(order_id),
        line_no       integer NOT NULL,
        ...
    );

**Right:**

    CREATE TABLE order_line (
        customer_no customer_no NOT NULL,
        order_no    order_no NOT NULL,
        line_no     line_no NOT NULL,
        ...,
        PRIMARY KEY (customer_no, order_no, line_no),
        FOREIGN KEY (customer_no, order_no)
            REFERENCES orders(customer_no, order_no)
    );

**Why it matters:** with surrogate keys, "give me lines for customer 42" requires `customer → orders → order_line`. With composite keys, it's `WHERE customer_no = 42`. Multiply across every parent/child query in your app — the surrogate model adds joins everywhere.

See [Hierarchical Composite Keys](hierarchical-keys.md) for the full fix pattern.

## Repeating Groups (1NF Violation)

Multiple values stuffed into one column.

**Wrong:**

    CREATE TABLE customer (
        customer_no customer_no PRIMARY KEY,
        phone_numbers text  -- "555-1234, 555-5678, 555-9012"
    );

**Right:**

    CREATE TABLE customer_phone (
        customer_no customer_no NOT NULL,
        phone_no    smallint NOT NULL,
        number      phone_number NOT NULL,
        type        phone_type NOT NULL,  -- 'mobile', 'home', 'work'
        PRIMARY KEY (customer_no, phone_no),
        FOREIGN KEY (customer_no) REFERENCES customer(customer_no)
    );

**Note on Postgres arrays:** `text[]` and `jsonb` arrays *are* a legitimate way to model truly atomic-but-multi-valued data (tags, ordered lists). But they violate 1NF if the elements are entities you'd want to query, constrain, or join — at that point, give them their own table.

## Partial Dependency (2NF Violation)

A non-key column depends on only part of a composite key.

**Wrong:**

    CREATE TABLE order_line (
        customer_no   customer_no NOT NULL,
        order_no      order_no NOT NULL,
        line_no       line_no NOT NULL,
        product_no    product_no NOT NULL,
        product_name  text NOT NULL,            -- depends only on product_no
        product_price money_amount NOT NULL,    -- depends only on product_no
        quantity      quantity NOT NULL,        -- depends on the full key
        PRIMARY KEY (customer_no, order_no, line_no)
    );

**Right:** move `product_name` and `product_price` to the `product` table:

    CREATE TABLE product (
        product_no   product_no PRIMARY KEY,
        product_name text NOT NULL,
        product_price money_amount NOT NULL
    );

    CREATE TABLE order_line (
        customer_no customer_no NOT NULL,
        order_no    order_no NOT NULL,
        line_no     line_no NOT NULL,
        product_no  product_no NOT NULL REFERENCES product(product_no),
        quantity    quantity NOT NULL,
        PRIMARY KEY (customer_no, order_no, line_no)
    );

**Exception:** historical immutable values (the price *at the time of sale*) belong in the line. Add a separate `unit_price_at_sale` column — that's not a partial dependency, it's a captured snapshot.

## Transitive Dependency (3NF Violation)

A non-key column depends on another non-key column.

**Wrong:**

    CREATE TABLE customer (
        customer_no customer_no PRIMARY KEY,
        zip_code    zip,
        city        text,    -- depends on zip_code, not customer_no
        state       text     -- depends on zip_code, not customer_no
    );

**Right:**

    CREATE TABLE zip_lookup (
        zip   zip PRIMARY KEY,
        city  text NOT NULL,
        state text NOT NULL
    );

    CREATE TABLE customer (
        customer_no customer_no PRIMARY KEY,
        zip_code    zip REFERENCES zip_lookup(zip)
    );

The customer table has zip; the zip_lookup table has city and state. Customers in the same zip share city/state automatically.

## Polymorphic Columns

A nullable column that's only meaningful when another column has a specific value.

**Wrong:**

    CREATE TABLE account (
        account_no account_no PRIMARY KEY,
        type       account_type NOT NULL,
        interest_rate growth_rate,    -- only set when type = 'savings'
        overdraft_limit money_amount  -- only set when type = 'checking'
    );

**Right:** base/subtype with PK inheritance — see [Base/Subtype Inheritance](basetype-subtype.md).

The polymorphic form has no way to enforce "savings accounts MUST have an interest rate" or "checking accounts MUST NOT have one" — those constraints live in app code (or worse, nowhere). The subtype form makes both required and exclusive at the schema level.

## Plural Table Names

`customers`, `orders`, `products`. Cosmetic, but a smell.

A table represents an *entity type*; rows are instances. Plural names imply the table *is* the collection, which leads to confusion in joins (`customers.id` vs `customer.id` — which entity does each row represent?). Singular is the convention in well-structured schemas.

The exception forced by Postgres: `order` is a reserved word, so most schemas use `orders` for that one table. That's a pragmatic compromise, not a license to pluralize everything.

## Floating Tables (No Clear Parent)

A child-like table with no FK to its conceptual parent.

**Wrong:**

    CREATE TABLE address (
        address_id bigserial PRIMARY KEY,
        line1      text NOT NULL,
        city       text NOT NULL,
        ...
    );
    -- No FK to customer, account, or anything

If addresses always belong to a customer (or account, or organization), make that relationship structural:

    CREATE TABLE customer_address (
        customer_no customer_no NOT NULL,
        address_no  address_no NOT NULL,
        line1       text NOT NULL,
        city        text NOT NULL,
        ...,
        PRIMARY KEY (customer_no, address_no),
        FOREIGN KEY (customer_no) REFERENCES customer(customer_no)
    );

If addresses are reused across multiple parents (geocoded location reference data), then the floating table is fine — but be honest about the use case.

## JSONB as a Schema Substitute

Postgres `jsonb` is excellent for *genuinely* semi-structured data (third-party API payloads, audit snapshots, user-customizable form data). It's terrible as a substitute for a real schema.

**Smell:**

    CREATE TABLE customer (
        customer_no customer_no PRIMARY KEY,
        data jsonb NOT NULL  -- contains email, name, phone, address, ...
    );

You've thrown away every constraint, every index (until you add expression indexes), every type guarantee. Queries like "find all customers in CA" become `WHERE data->>'state' = 'CA'` — slow, untyped, no FK to a state reference table.

**Use jsonb when:**

- Schema genuinely varies per row (form responses, plugin metadata)
- Storing third-party payloads verbatim for replay/debugging
- Sparse attributes where 90% of rows have NULL

**Don't use jsonb when:**

- The fields are predictable across rows
- You'd want to FK any of the values
- You'd want to enforce types on any of the values

The discipline: every field that has a predictable role and type belongs in its own typed column with constraints. `jsonb` is for the rest.

For the theoretical foundation behind all Normal Forms, see `relational-db-design`.

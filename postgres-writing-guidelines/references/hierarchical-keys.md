# Hierarchical Composite Keys


Tables in a parent-child hierarchy use composite primary keys that grow wider with each level. Each child inherits the full PK of its parent and adds its own discriminator — making the key itself a path that encodes lineage from root to leaf.

## Table of Contents

- [The Pattern](#the-pattern)
- [Why Composite Keys Win](#why-composite-keys-win)
- [Per-Parent Sequences](#per-parent-sequences)
- [Max-Plus-One Functions (Alternative)](#max-plus-one-functions-alternative)
- [Insert Procedure](#insert-procedure)
- [Temporal Children](#temporal-children)
- [Sibling Tables](#sibling-tables)
- [Disk Locality](#disk-locality)

---

## The Pattern

    customer        (customer_no)
    order           (customer_no, order_no)
    order_line      (customer_no, order_no, line_no)
    order_shipment  (customer_no, order_no, line_no, shipment_no)

The PK of `order_shipment` tells you everything: which customer, which order, which line, which shipment. No traversal needed to reconstruct lineage.

    CREATE TABLE customer (
        customer_no customer_no PRIMARY KEY DEFAULT nextval('customer_customer_no_seq'),
        ...
    );

    CREATE TABLE orders (
        customer_no customer_no NOT NULL,
        order_no    order_no NOT NULL,
        ordered_at  ts_now NOT NULL,
        ...,
        PRIMARY KEY (customer_no, order_no),
        CONSTRAINT order_belongs_to_customer
            FOREIGN KEY (customer_no) REFERENCES customer(customer_no)
    );

    CREATE TABLE order_line (
        customer_no customer_no NOT NULL,
        order_no    order_no NOT NULL,
        line_no     line_no NOT NULL,
        product_no  product_no NOT NULL,
        quantity    quantity NOT NULL,
        ...,
        PRIMARY KEY (customer_no, order_no, line_no),
        CONSTRAINT order_line_belongs_to_order
            FOREIGN KEY (customer_no, order_no)
                REFERENCES orders(customer_no, order_no)
                ON DELETE CASCADE
    );

## Why Composite Keys Win

**Direct joins.** Querying lines for a customer doesn't require joining through `orders`:

    SELECT * FROM order_line WHERE customer_no = 42;

With surrogate `BIGSERIAL` keys on every child table, that query would have to join `customer → orders → order_line`.

**Path-encoded identity.** `(42, 7, 3)` reads as "customer 42's order 7's line 3" — meaningful at a glance.

**Cascading delete is correct by default.** Removing a parent removes all descendants without manual scoping.

**Partition-friendly.** A composite-keyed table partitions naturally by the leading column.

## Per-Parent Sequences

The cleanest Postgres way to scope IDs to a parent: a sequence per parent row. But this only makes sense when parent count is bounded — for unbounded parents (like customers), use the max-plus-one pattern instead, since per-row sequences would proliferate.

For bounded scopes (e.g., a single global counter or per-tenant counter):

    CREATE SEQUENCE order_order_no_seq;     -- global, monotonic
    -- or one per tenant if multi-tenant:
    -- (less common; max-plus-one is usually simpler)

## Max-Plus-One Functions (Alternative)

A scalar function returns `MAX(col) + 1` scoped to the parent key:

    CREATE OR REPLACE FUNCTION fn_next_order_no(p_customer_no customer_no)
    RETURNS order_no
    LANGUAGE sql STABLE AS $$
        SELECT COALESCE(MAX(order_no), 0) + 1
        FROM orders
        WHERE customer_no = p_customer_no;
    $$;

    CREATE OR REPLACE FUNCTION fn_next_line_no(
        p_customer_no customer_no,
        p_order_no    order_no
    )
    RETURNS line_no
    LANGUAGE sql STABLE AS $$
        SELECT COALESCE(MAX(line_no), 0) + 1
        FROM order_line
        WHERE customer_no = p_customer_no AND order_no = p_order_no;
    $$;

**Concurrency caveat.** Max-plus-one is racy under concurrent inserts to the same parent — two simultaneous calls return the same number. Mitigate with:

1. A unique index on the composite PK (Postgres rejects the duplicate, caller retries) — relies on the unique constraint as the lock
2. An `UPDATE customer SET order_count = order_count + 1` advisory step that serializes per-customer
3. `pg_advisory_xact_lock(p_customer_no::bigint)` to serialize per-parent within the transaction

For high-concurrency parents, use a parent-scoped sequence instead.

## Insert Procedure

Insert into the deepest level via a PROCEDURE that pulls the next number:

    CREATE OR REPLACE PROCEDURE pr_add_order_line(
        p_customer_no customer_no,
        p_order_no    order_no,
        p_product_no  product_no,
        p_quantity    quantity,
        OUT p_line_no line_no
    )
    LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM fn_assert_not_in_transaction();
        PERFORM pg_advisory_xact_lock(p_customer_no::bigint, p_order_no::bigint);

        p_line_no := fn_next_line_no(p_customer_no, p_order_no);

        INSERT INTO order_line(customer_no, order_no, line_no, product_no, quantity)
        VALUES (p_customer_no, p_order_no, p_line_no, p_product_no, p_quantity);

        COMMIT;
    EXCEPTION WHEN OTHERS THEN
        ROLLBACK;
        RAISE;
    END;
    $$;

The advisory lock serializes inserts to this specific order, eliminating the max-plus-one race.

## Temporal Children

Children with a time dimension include the timestamp in the PK:

    CREATE TABLE account_balance_snapshot (
        account_no  account_no NOT NULL,
        snapshot_at ts_now NOT NULL,
        balance     money_amount NOT NULL,
        PRIMARY KEY (account_no, snapshot_at),
        CONSTRAINT balance_snapshot_belongs_to_account
            FOREIGN KEY (account_no) REFERENCES account(account_no)
    );

`(account_no, snapshot_at)` is a natural composite key — no surrogate `snapshot_id` needed. Latest snapshot per account:

    SELECT DISTINCT ON (account_no) account_no, snapshot_at, balance
    FROM account_balance_snapshot
    ORDER BY account_no, snapshot_at DESC;

## Sibling Tables

Two children of the same parent share the parent's PK columns:

    -- Children of order:
    order_line       (customer_no, order_no, line_no)
    order_payment    (customer_no, order_no, payment_no)
    order_shipment   (customer_no, order_no, shipment_no)

Each child gets its own counter, scoped to `(customer_no, order_no)`.

## Disk Locality

Composite PKs cluster related data physically. By default, Postgres orders heap inserts by insertion time, but `CLUSTER` reorders on the PK index:

    CLUSTER order_line USING order_line_pkey;

After clustering, all lines of one order sit contiguously on disk. Subsequent reads of `WHERE customer_no = 42 AND order_no = 7` hit one or two pages instead of scattering across the table.

Postgres doesn't auto-maintain clustering — re-run `CLUSTER` periodically or use `pg_repack` for online clustering. For tables where insertion order matches query order (append-only logs), no clustering needed.

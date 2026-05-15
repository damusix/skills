# Base/Subtype Inheritance


Use **primary key inheritance** for entities that share common attributes but have specialized ones. The base table holds shared attributes plus a type discriminator. Each subtype table inherits the base PK as both its PK and its FK to the base, plus a trigger enforcing the discriminator.

**Don't use Postgres `INHERITS`** — it has FK and uniqueness gotchas (FKs from inheritance children don't enforce against the parent table; UNIQUE constraints don't span the hierarchy). The explicit FK + trigger pattern below is robust.

## Table of Contents

- [The Pattern](#the-pattern)
- [Base Table](#base-table)
- [Type Discriminator Reference](#type-discriminator-reference)
- [Subtype Tables](#subtype-tables)
- [Type Enforcement Triggers](#type-enforcement-triggers)
- [Inserting via Procedure](#inserting-via-procedure)
- [Querying Across the Hierarchy](#querying-across-the-hierarchy)
- [Referencing Base vs Subtype](#referencing-base-vs-subtype)

---

## The Pattern

    account (base)
        type ∈ {savings, checking, money_market}
        ↓
        ├─ savings_account
        ├─ checking_account
        └─ money_market_account

Each subtype's PK is the same column as the base PK, doubling as a FK. A trigger on each subtype enforces that the referenced base row has the matching `type`.

## Base Table

    CREATE TABLE account (
        account_no  account_no PRIMARY KEY DEFAULT nextval('account_account_no_seq'),
        type        account_type NOT NULL,
        opened_at   ts_now NOT NULL,
        closed_at   timestamptz,
        owner_id    user_id NOT NULL,
        balance     money_amount NOT NULL DEFAULT 0,

        CONSTRAINT account_is_classified_by_type
            FOREIGN KEY (type) REFERENCES account_type(type)
    );

## Type Discriminator Reference

Always create + seed in the same DDL script:

    CREATE TABLE account_type (
        type type_name PRIMARY KEY
    );

    INSERT INTO account_type(type) VALUES
        ('savings'),
        ('checking'),
        ('money_market'),
        ('certificate_of_deposit')
    ON CONFLICT DO NOTHING;

`type_name` is a domain (`CREATE DOMAIN type_name AS varchar(40) NOT NULL CHECK (VALUE ~ '^[a-z_]+$')`).

## Subtype Tables

    CREATE TABLE savings_account (
        account_no    account_no PRIMARY KEY,
        interest_rate growth_rate NOT NULL,
        min_balance   money_amount NOT NULL DEFAULT 0,

        CONSTRAINT savings_account_is_account
            FOREIGN KEY (account_no) REFERENCES account(account_no)
                ON DELETE CASCADE
    );

    CREATE TABLE checking_account (
        account_no       account_no PRIMARY KEY,
        overdraft_limit  money_amount NOT NULL DEFAULT 0,

        CONSTRAINT checking_account_is_account
            FOREIGN KEY (account_no) REFERENCES account(account_no)
                ON DELETE CASCADE
    );

`ON DELETE CASCADE` ensures deleting the base row removes the subtype row. (You usually call `pr_remove_account` to handle both layers explicitly, but the cascade is a safety net.)

## Type Enforcement Triggers

See [Cross-Table Constraints](cross-table-constraints.md) for the full pattern. Quick form:

    CREATE OR REPLACE FUNCTION tg_savings_account_check_type()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM account
            WHERE account_no = NEW.account_no AND type = 'savings'
        ) THEN
            RAISE EXCEPTION 'savings_account requires account.type = ''savings'''
                USING ERRCODE = 'P0010';
        END IF;
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER savings_account_must_be_savings_type
        BEFORE INSERT OR UPDATE ON savings_account
        FOR EACH ROW EXECUTE FUNCTION tg_savings_account_check_type();

Also enforce on `account` that `type` cannot change while subtype rows exist (see Cross-Table Constraints).

## Inserting via Procedure

Create base + subtype atomically in one PROCEDURE:

    CREATE OR REPLACE PROCEDURE pr_add_savings_account(
        p_owner_id      user_id,
        p_interest_rate growth_rate,
        p_min_balance   money_amount,
        OUT p_account_no account_no
    )
    LANGUAGE plpgsql AS $$
    BEGIN
        PERFORM fn_assert_not_in_transaction();

        INSERT INTO account(type, owner_id) VALUES ('savings', p_owner_id)
        RETURNING account_no INTO p_account_no;

        INSERT INTO savings_account(account_no, interest_rate, min_balance)
        VALUES (p_account_no, p_interest_rate, p_min_balance);

        COMMIT;
    EXCEPTION WHEN OTHERS THEN
        ROLLBACK;
        RAISE;
    END;
    $$;

## Querying Across the Hierarchy

**All accounts (base only):**

    SELECT * FROM account WHERE owner_id = fn_current_app_user_id();

**Specific subtype (join):**

    SELECT a.account_no, a.balance, s.interest_rate, s.min_balance
    FROM account a
    JOIN savings_account s USING (account_no)
    WHERE a.owner_id = fn_current_app_user_id();

**Polymorphic view (one row per account, NULL for unrelated subtype columns):**

    CREATE VIEW vw_customer_my_accounts AS
    SELECT
        a.account_no, a.type, a.balance, a.opened_at,
        s.interest_rate, s.min_balance,
        c.overdraft_limit
    FROM account a
    LEFT JOIN savings_account s  USING (account_no)
    LEFT JOIN checking_account c USING (account_no);

RLS on `account` filters automatically — the view inherits the filter through the base table.

## Referencing Base vs Subtype

Other tables can FK to either:

**To base (any account type):**

    CREATE TABLE account_statement (
        account_no  account_no NOT NULL,
        statement_no statement_no,
        ...,
        PRIMARY KEY (account_no, statement_no),
        CONSTRAINT account_statement_belongs_to_account
            FOREIGN KEY (account_no) REFERENCES account(account_no)
    );

**To subtype (only savings accounts):**

    CREATE TABLE savings_interest_payment (
        account_no    account_no NOT NULL,
        payment_no    payment_no,
        amount        money_amount NOT NULL,
        ...,
        PRIMARY KEY (account_no, payment_no),
        CONSTRAINT savings_interest_belongs_to_savings_account
            FOREIGN KEY (account_no) REFERENCES savings_account(account_no)
    );

The FK to `savings_account` enforces at the schema level that `savings_interest_payment.account_no` *must* be a savings account. No additional triggers needed — the FK does the work.

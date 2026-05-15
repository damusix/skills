# Testing Patterns


Database tests must run against a real Postgres, not a mock. The skill's user-instruction is explicit: "NEVER mock the database in these tests." This page covers how to do that affordably: transactional isolation, fixture management, pgTAP for unit tests, and how to test RLS policies.

## Table of Contents

- [The Core Discipline: Test Against Real Postgres](#the-core-discipline-test-against-real-postgres)
- [Transactional Test Isolation](#transactional-test-isolation)
- [Fixture Management](#fixture-management)
- [pgTAP for In-Database Unit Tests](#ptap-for-in-database-unit-tests)
- [Testing RLS Policies](#testing-rls-policies)
- [Testing Triggers](#testing-triggers)
- [Testing Procedures and Functions](#testing-procedures-and-functions)
- [Performance Regression Tests](#performance-regression-tests)
- [CI Setup](#ci-setup)

---

## The Core Discipline: Test Against Real Postgres

A test that uses a mocked DB tests your mock. The first time you hit production with a real schema mismatch, RLS misconfiguration, or constraint violation, that test will tell you it passed.

Run tests against:

- A real Postgres instance (Docker container, CI service, or local install)
- The same major version as production
- The same extensions enabled
- The same schema migrated to the same point

The cost — a few seconds of container spin-up, a few MB of disk — is trivial compared to the cost of a bug that bypassed your mocks.

## Transactional Test Isolation

The fastest way to keep tests independent: wrap each test in a transaction, roll back at the end:

    -- Pseudo-code in test framework
    beforeEach(async () => {
        await db.query('BEGIN');
    });

    afterEach(async () => {
        await db.query('ROLLBACK');
    });

Every test sees the same baseline schema and seed data; nothing one test inserts leaks to the next. Postgres can run thousands of these per second.

**Limitations:**

- Tests can't span multiple transactions (rare in unit tests, common in integration tests)
- Tests can't call procedures that do their own `COMMIT` — those must run in a separate connection or against a non-rolled-back schema
- DDL inside the transaction is rolled back, but the cost (per-test schema work) is high; do shared DDL in setup, not per-test

For tests that must span transactions, use a different strategy: truncate-and-reseed between tests, or per-test schemas.

## Fixture Management

Three approaches, in order of preference:

**1. Inline INSERTs in the test.** Best for unit tests. The test owns its data and you can read what it depends on:

    test('cannot transfer more than balance', async () => {
        const acct = await db.query(`
            INSERT INTO account(account_no, type, owner_id, balance)
            VALUES (DEFAULT, 'checking', 1, 100) RETURNING account_no
        `);
        // ...
    });

**2. Factory functions.** When fixture setup is verbose, extract to typed helpers:

    async function createAccount(overrides = {}) {
        return db.query(`
            INSERT INTO account(type, owner_id, balance)
            VALUES ($1, $2, $3) RETURNING *
        `, [overrides.type ?? 'checking', overrides.owner_id ?? 1, overrides.balance ?? 100]);
    }

**3. Seed SQL files.** For shared baseline data (reference tables, app_settings), run a seed script once before all tests. Don't use it for per-test data.

Avoid: large shared fixture files (`fixtures.sql` with 1000 rows). They couple tests and make failure context murky.

## pgTAP for In-Database Unit Tests

pgTAP is a TAP-emitting test framework that runs inside Postgres — write SQL tests, get TAP output:

    CREATE EXTENSION IF NOT EXISTS pgtap;

    BEGIN;
    SELECT plan(3);

    SELECT has_table('app', 'customer');
    SELECT has_column('app', 'customer', 'email');
    SELECT col_not_null('app', 'customer', 'email');

    SELECT * FROM finish();
    ROLLBACK;

Run with `pg_prove` (a TAP runner):

    pg_prove --dbname mydb tests/*.sql

Use pgTAP for:

- Schema assertions (table/column/index/constraint exists and is configured right)
- Migration tests (apply, assert state, roll back)
- Function/procedure unit tests where the call site is pure SQL

For application-layer logic, your normal test framework is usually a better fit — pgTAP doesn't help you assert HTTP responses.

## Testing RLS Policies

RLS policies depend on the current role. To test them, `SET ROLE` to assume a non-privileged identity:

    -- Setup as superuser/admin
    INSERT INTO customer(customer_no, owner_id) VALUES (1, 'alice'), (2, 'bob');

    -- Test as Alice
    SET LOCAL ROLE app_user;
    SET LOCAL app.user_id = 'alice';

    SELECT COUNT(*) FROM customer;
    -- Should return 1 (only Alice's row)

    RESET ROLE;

In test framework code:

    test('customer sees only own rows under RLS', async () => {
        await db.query("SET LOCAL ROLE app_user");
        await db.query("SET LOCAL app.user_id = 'alice'");

        const res = await db.query('SELECT * FROM customer');
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].owner_id).toBe('alice');
    });

**Crucial:** if your test connection is a superuser or `BYPASSRLS`, policies don't apply. The `SET LOCAL ROLE` is what makes the test meaningful.

## Testing Triggers

Triggers fire on DML, so test the DML and assert the outcome:

    test('audit trigger captures customer update', async () => {
        await db.query("INSERT INTO customer(customer_no, full_name) VALUES (1, 'Old')");
        await db.query("UPDATE customer SET full_name = 'New' WHERE customer_no = 1");

        const audit = await db.query(`
            SELECT action, change_diff FROM customer_audit
            WHERE customer_no = 1 ORDER BY changed_at DESC LIMIT 1
        `);

        expect(audit.rows[0].action).toBe('UPDATE');
        expect(audit.rows[0].change_diff).toEqual({ full_name: 'New' });
    });

For triggers that raise on invalid state, assert the EXCEPTION:

    test('savings account rejects non-savings parent', async () => {
        await db.query("INSERT INTO account(account_no, type) VALUES (1, 'checking')");

        await expect(
            db.query("INSERT INTO savings_account(account_no, ...) VALUES (1, ...)")
        ).rejects.toMatchObject({ code: 'P0010' });
    });

Match on the SQLSTATE, not the message — messages can change, codes are the contract.

## Testing Procedures and Functions

Procedures that own their transactions (`COMMIT` inside) cannot be called from within a test transaction. Two options:

**A. Test against a clean DB and truncate between tests.** Slower but accurate.

**B. Refactor the procedure to expose its core as a `_utx`-style function that doesn't commit.** Test that. Wrap with a thin procedure that adds the commit boundary in production code.

For pure functions (no DML, no COMMIT), call them directly inside the test transaction:

    test('fn_next_order_no returns 1 for empty parent', async () => {
        const res = await db.query('SELECT fn_next_order_no(1) AS next');
        expect(res.rows[0].next).toBe(1);
    });

## Performance Regression Tests

For queries on the critical path, add tests that fail if the plan changes shape:

    test('customer search uses index, not seq scan', async () => {
        const plan = await db.query(`
            EXPLAIN (FORMAT JSON)
            SELECT * FROM customer WHERE email = $1
        `, ['alice@example.com']);

        const planJson = plan.rows[0]['QUERY PLAN'][0];
        expect(planJson.Plan['Node Type']).toBe('Index Scan');
    });

Don't assert on absolute timings — too flaky. Assert on plan shape.

## CI Setup

Minimum CI requirements:

1. Spin up a fresh Postgres container per job (same major version as production)
2. Enable the extensions your schema uses
3. Apply all migrations
4. Run seed if needed
5. Run tests with parallelism = 1 *or* with truly isolated transactions per test

For monorepo speed, cache the post-migration Postgres data directory and skip migrations when the migration files haven't changed. Most CI systems support this.

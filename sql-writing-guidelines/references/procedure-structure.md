# Procedure Structure


Every stored procedure follows a mandatory **5-block structure**. The blocks must appear in this order.

## Table of Contents

- [_trx — Transaction Owner](#trx--transaction-owner)
- [_utx — Transaction Participant](#utx--transaction-participant)
- [_ut — Utility](#ut--utility)
- [Composing _trx with _utx](#composing-trx-with-utx)
- [DML Error Checking](#dml-error-checking)
- [AddOrModify with MERGE](#addormodify-with-merge)

---

## _trx — Transaction Owner

Opens and commits/rolls back its own transaction. Rejects if already inside one.

    CREATE OR ALTER PROCEDURE TransferFunds_trx
        @FromAccountNo AccountNo,
        @ToAccountNo AccountNo,
        @Amount _Money
    AS BEGIN

        -- BLOCK 1: DECLARATION
        DECLARE @ErrNo INT;
        DECLARE @RowCnt INT;

        -- BLOCK 2: VALIDATION
        IF (@@TRANCOUNT > 0) BEGIN
            RAISERROR(50012, 16, 1, 'TransferFunds_trx');
            GOTO EXIT_ERROR;
        END

        IF @FromAccountNo IS NULL BEGIN
            RAISERROR(50002, 16, 1, 'TransferFunds_trx: FromAccountNo');
            GOTO EXIT_ERROR;
        END

        IF @ToAccountNo IS NULL BEGIN
            RAISERROR(50002, 16, 1, 'TransferFunds_trx: ToAccountNo');
            GOTO EXIT_ERROR;
        END

        IF @Amount IS NULL OR @Amount <= 0 BEGIN
            RAISERROR(50010, 16, 1, 'TransferFunds_trx: Amount must be positive');
            GOTO EXIT_ERROR;
        END

        -- BLOCK 3: TRANSACTION
        BEGIN TRANSACTION TransferFunds_trx;

            -- 3A: LOCKING (prevent concurrent modification)
            SELECT * FROM Account WITH (XLOCK, HOLDLOCK)
            WHERE AccountNo IN (@FromAccountNo, @ToAccountNo);

            -- 3B: BUSINESS LOGIC
            UPDATE Account SET Balance = Balance - @Amount
            WHERE AccountNo = @FromAccountNo;

            SELECT @RowCnt = @@ROWCOUNT, @ErrNo = @@ERROR;

            IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;
            IF (@RowCnt = 0) BEGIN
                RAISERROR(50005, 16, 1, 'TransferFunds_trx: debit Account');
                GOTO EXIT_TRANSACTION;
            END

            UPDATE Account SET Balance = Balance + @Amount
            WHERE AccountNo = @ToAccountNo;

            SELECT @RowCnt = @@ROWCOUNT, @ErrNo = @@ERROR;

            IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;
            IF (@RowCnt = 0) BEGIN
                RAISERROR(50005, 16, 1, 'TransferFunds_trx: credit Account');
                GOTO EXIT_TRANSACTION;
            END

        -- BLOCK 4: COMMIT
        COMMIT TRANSACTION TransferFunds_trx;
        RETURN 0;

        -- BLOCK 5: ERROR HANDLING
    EXIT_TRANSACTION:
        ROLLBACK TRANSACTION TransferFunds_trx;

    EXIT_ERROR:
        RETURN 1;

    END;

### Key rules for _trx

- Transaction name matches procedure name
- Validates `@@TRANCOUNT = 0` — refuses to run inside another transaction
- Each param validated individually with specific context in the error message
- Error check after every DML (see DML Error Checking below)
- `EXIT_TRANSACTION` label rolls back before falling through to `EXIT_ERROR`

---

## _utx — Transaction Participant

Called inside an existing transaction. Rejects if NOT inside one. Does not open its own transaction.

    CREATE OR ALTER PROCEDURE AddTransaction_utx
        @AccountNo AccountNo,
        @Amount _Money,
        @Description Description,
        @TransactionNo _Int OUTPUT
    AS BEGIN

        DECLARE @ErrNo INT;
        DECLARE @RowCnt INT;

        -- Validates IS inside transaction
        IF (@@TRANCOUNT = 0) BEGIN
            RAISERROR(50013, 16, 1, 'AddTransaction_utx');
            GOTO EXIT_ERROR;
        END

        IF @AccountNo IS NULL BEGIN
            RAISERROR(50002, 16, 1, 'AddTransaction_utx: AccountNo');
            GOTO EXIT_ERROR;
        END

        -- Business logic (no BEGIN TRANSACTION — caller owns it)
        SET @TransactionNo = (COALESCE((SELECT MAX(TransactionNo) FROM [Transaction]), 0) + 1);

        INSERT INTO [Transaction] (TransactionNo, AccountNo, Amount, [Description])
        VALUES (@TransactionNo, @AccountNo, @Amount, @Description);

        SELECT @RowCnt = @@ROWCOUNT, @ErrNo = @@ERROR;

        IF (@ErrNo <> 0) GOTO EXIT_ERROR;
        IF (@RowCnt <> 1) BEGIN
            RAISERROR(50004, 16, 1, 'AddTransaction_utx: Transaction');
            GOTO EXIT_ERROR;
        END

        RETURN 0;

    EXIT_ERROR:
        RETURN 1;

    END;

### Key rules for _utx

- No `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK` — the caller manages the boundary
- Validates `@@TRANCOUNT > 0` — refuses to run outside a transaction
- No `EXIT_TRANSACTION` label (no transaction to roll back)
- Uses OUTPUT parameters to pass generated values back to the caller

---

## _ut — Utility

No transaction requirement. Typically for read operations or simple lookups.

    CREATE OR ALTER PROCEDURE FindCustomerByEmail_ut
        @Email Email
    AS BEGIN

        IF (@Email IS NULL) BEGIN
            RAISERROR(50002, 16, 1, 'FindCustomerByEmail_ut: Email');
            GOTO EXIT_ERROR;
        END

        SELECT CustomerNo, FullName, Email, CreatedAt
        FROM Manager_AllCustomers_V
        WHERE Email = @Email;

        RETURN 0;

    EXIT_ERROR:
        RETURN 1;

    END;

### Key rules for _ut

- No transaction state validation
- Reads from views (never directly from tables)
- Minimal structure — may skip declaration block if no working variables needed

---

## Composing _trx with _utx

A `_trx` procedure opens the transaction, then delegates subtasks to `_utx` procedures:

    BEGIN TRANSACTION OpenAccount_trx;

        -- Step 1: create the base record via _utx
        EXEC @ErrNo = AddAccount_utx
            @Type = 'Savings',
            @AccountNo = @NewAccountNo OUTPUT;

        IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;

        -- Step 2: create the subtype record
        INSERT INTO SavingsAccount (AccountNo, InterestRate, MinBalance)
        VALUES (@NewAccountNo, @InterestRate, @MinBalance);

        SELECT @RowCnt = @@ROWCOUNT, @ErrNo = @@ERROR;

        IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;
        IF (@RowCnt <> 1) BEGIN
            RAISERROR(50004, 16, 1, 'OpenAccount_trx: SavingsAccount');
            GOTO EXIT_TRANSACTION;
        END

    COMMIT TRANSACTION OpenAccount_trx;
    RETURN 0;

The `_utx` validates it's inside a transaction, does its work, and returns. If it fails, the `_trx` catches the error return code and rolls back the whole unit.

---

## DML Error Checking

After **every** INSERT, UPDATE, or DELETE, immediately capture and check:

    -- The DML operation
    UPDATE Account SET Status = 'Closed'
    WHERE AccountNo = @AccountNo;

    -- Capture both atomically (@@ERROR resets to 0 after any successful statement)
    SELECT @RowCnt = @@ROWCOUNT, @ErrNo = @@ERROR;

    -- Check error first
    IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;

    -- Then check row count with the appropriate error code
    IF (@RowCnt = 0) BEGIN
        RAISERROR(50005, 16, 1, 'CloseAccount_trx: Account');
        GOTO EXIT_TRANSACTION;
    END

**Row count expectations by operation:**
- **INSERT single row**: expect `@RowCnt = 1`, error with 50004 (EXIT_NOT_ADDED)
- **UPDATE**: expect `@RowCnt > 0` (or `= 1` for single-row), error with 50005 (EXIT_NOT_MODIFIED)
- **DELETE**: expect `@RowCnt > 0` (or `= 1` for single-row), error with 50006 (EXIT_NOT_REMOVED)

`@@ROWCOUNT` and `@@ERROR` are reset by any statement — including `SET`, which resets `@@ERROR` to 0 on success. A single `SELECT` captures both atomically before either is lost.

---

## AddOrModify with MERGE

When a record should be created if it doesn't exist or updated if it does, use a single `AddOrModify_` procedure with a `MERGE` statement. This eliminates the caller needing to know whether the record exists and produces a cleaner API:

    CREATE OR ALTER PROCEDURE AddOrModify_UnitType_trx
        @UnitTypeNo _Int,
        @Name Name,
        @Category _Type
    AS BEGIN

        DECLARE @ErrNo INT;
        DECLARE @RowCnt INT;

        IF (@@TRANCOUNT > 0) BEGIN
            RAISERROR(50012, 16, 1, 'AddOrModify_UnitType_trx');
            GOTO EXIT_ERROR;
        END

        BEGIN TRANSACTION AddOrModify_UnitType_trx;

            MERGE UnitType AS target
            USING (
                SELECT @UnitTypeNo AS UnitTypeNo, @Name AS [Name], @Category AS Category
            ) AS source
            ON (target.UnitTypeNo = source.UnitTypeNo)
            WHEN MATCHED THEN
                UPDATE SET [Name] = source.[Name], Category = source.Category
            WHEN NOT MATCHED THEN
                INSERT (UnitTypeNo, [Name], Category)
                VALUES (source.UnitTypeNo, source.[Name], source.Category);

            SELECT @RowCnt = @@ROWCOUNT, @ErrNo = @@ERROR;

            IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;
            IF (@RowCnt <> 1) BEGIN
                RAISERROR(50005, 16, 1, 'AddOrModify_UnitType_trx: UnitType');
                GOTO EXIT_TRANSACTION;
            END

        COMMIT TRANSACTION AddOrModify_UnitType_trx;
        RETURN 0;

    EXIT_TRANSACTION:
        ROLLBACK TRANSACTION AddOrModify_UnitType_trx;

    EXIT_ERROR:
        RETURN 1;

    END;

The MERGE handles both insert and update atomically. The DML error check after MERGE follows the same pattern as any other DML — capture `@@ROWCOUNT` and `@@ERROR` immediately.

---

## See Also

- [Error Handling](error-handling.md) — the structured error code catalog (50001–50014) used in RAISERROR calls
- [Query Patterns](query-patterns.md) — batch operations, parameter sniffing fixes, and SARGability for procedure logic

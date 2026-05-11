# Base/Subtype Inheritance


How to implement, query, and mutate base/subtype hierarchies using primary key inheritance and functional constraints.

## Table of Contents

- [The Pattern](#the-pattern)
- [The IsType Function](#the-istype-function)
- [Referencing Base vs Subtype](#referencing-base-vs-subtype)
- [Creating Subtypes in Procedures](#creating-subtypes-in-procedures)
- [Views Over Subtypes](#views-over-subtypes)

---

## The Pattern

A base table holds shared attributes and a type discriminator. Each subtype table inherits the base table's primary key as both its PK and FK:

    -- Type lookup table — seed all known values immediately
    CREATE TABLE VehicleType (
        [Type] _Type PRIMARY KEY
    );

    INSERT INTO VehicleType([Type]) VALUES
        ('Car'),
        ('Truck'),
        ('Motorcycle');

    -- Base table
    CREATE TABLE Vehicle (
        VehicleNo _Int PRIMARY KEY,
        [Type] _Type NOT NULL,
        Make Name NOT NULL,
        Model Name NOT NULL,
        [Year] _Int NOT NULL,

        CONSTRAINT Vehicle_IsClassifiedBy_VehicleType
            FOREIGN KEY([Type]) REFERENCES VehicleType([Type])
    );

    -- Subtype: PK = FK to base
    CREATE TABLE Car (
        VehicleNo _Int PRIMARY KEY,
        DoorCount _Int NOT NULL,
        TrunkCapacity _Int NULL,

        CONSTRAINT Car_Is_Vehicle
            FOREIGN KEY(VehicleNo) REFERENCES Vehicle(VehicleNo),

        CONSTRAINT Car_IsVehicleType
            CHECK (dbo.Vehicle_IsType_fn(VehicleNo, 'Car') = 1)
    );

    CREATE TABLE Truck (
        VehicleNo _Int PRIMARY KEY,
        PayloadCapacity _Int NOT NULL,
        TowingCapacity _Int NOT NULL,

        CONSTRAINT Truck_Is_Vehicle
            FOREIGN KEY(VehicleNo) REFERENCES Vehicle(VehicleNo),

        CONSTRAINT Truck_IsVehicleType
            CHECK (dbo.Vehicle_IsType_fn(VehicleNo, 'Truck') = 1)
    );

Three things make this work:
1. **PK inheritance**: `Car.VehicleNo` IS `Vehicle.VehicleNo` — one identity, two tables of attributes
2. **FK constraint**: ensures the subtype row can't exist without its base row
3. **Functional constraint**: ensures the base row's type discriminator matches this subtype

---

## The IsType Function

Each base table gets a check function used in subtype constraints:

    CREATE OR ALTER FUNCTION dbo.Vehicle_IsType_fn (
        @VehicleNo _Int,
        @ExpectedType _Type
    )
    RETURNS BIT
    AS BEGIN
        IF EXISTS (
            SELECT 1 FROM Vehicle
            WHERE VehicleNo = @VehicleNo
                AND [Type] = @ExpectedType
        )
            RETURN 1;

        RETURN 0;
    END;

This function is called by the CHECK constraint on every INSERT and UPDATE to the subtype table. If you try to insert a Car row for a Vehicle whose type is 'Truck', the database rejects it.

---

## Referencing Base vs Subtype

**Foreign keys from other tables** can point to either level:

    -- Any vehicle type is valid for a registration
    CREATE TABLE Registration (
        RegistrationNo _Int PRIMARY KEY,
        VehicleNo _Int NOT NULL,

        CONSTRAINT Registration_IsFor_Vehicle
            FOREIGN KEY(VehicleNo) REFERENCES Vehicle(VehicleNo)  -- base table
    );

    -- Only cars are valid for this parking garage
    CREATE TABLE CompactParkingSpot (
        SpotNo _Int PRIMARY KEY,
        VehicleNo _Int NULL,

        CONSTRAINT CompactSpot_IsOccupiedBy_Car
            FOREIGN KEY(VehicleNo) REFERENCES Car(VehicleNo)  -- subtype table
    );

Referencing the base table accepts any subtype. Referencing the subtype table restricts to that specific type — the schema enforces the business rule.

---

## Creating Subtypes in Procedures

Use the `_trx` / `_utx` composition pattern. The base record and subtype record must be created atomically:

    CREATE OR ALTER PROCEDURE AddCar_trx
        @Make Name,
        @Model Name,
        @Year _Int,
        @DoorCount _Int,
        @TrunkCapacity _Int = NULL
    AS BEGIN

        DECLARE @ErrNo INT;
        DECLARE @RowCnt INT;
        DECLARE @NewVehicleNo _Int;

        IF (@@TRANCOUNT > 0) BEGIN
            RAISERROR(50012, 16, 1, 'AddCar_trx');
            GOTO EXIT_ERROR;
        END

        BEGIN TRANSACTION AddCar_trx;

            -- Step 1: create base record via _utx
            EXEC @ErrNo = AddVehicle_utx
                @Type = 'Car',
                @Make = @Make,
                @Model = @Model,
                @Year = @Year,
                @VehicleNo = @NewVehicleNo OUTPUT;

            IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;

            -- Step 2: create subtype record
            INSERT INTO Car (VehicleNo, DoorCount, TrunkCapacity)
            VALUES (@NewVehicleNo, @DoorCount, @TrunkCapacity);

            SELECT @RowCnt = @@ROWCOUNT, @ErrNo = @@ERROR;

            IF (@ErrNo <> 0) GOTO EXIT_TRANSACTION;
            IF (@RowCnt <> 1) BEGIN
                RAISERROR(50004, 16, 1, 'AddCar_trx: Car');
                GOTO EXIT_TRANSACTION;
            END

        COMMIT TRANSACTION AddCar_trx;
        RETURN 0;

    EXIT_TRANSACTION:
        ROLLBACK TRANSACTION AddCar_trx;

    EXIT_ERROR:
        RETURN 1;

    END;

The `_utx` creates the Vehicle row (with `Type = 'Car'`), returns the generated VehicleNo, and the `_trx` continues to create the Car row. If either step fails, the whole transaction rolls back.

---

## Views Over Subtypes

Views typically JOIN base and subtype tables to present a complete picture:

    CREATE OR ALTER VIEW Manager_CarFleet_V AS
    SELECT
        V.VehicleNo,
        V.Make,
        V.Model,
        V.[Year],
        C.DoorCount,
        C.TrunkCapacity,
        V.CreatedAt
    FROM Vehicle V
    INNER JOIN Car C ON V.VehicleNo = C.VehicleNo;

For a unified view across all subtypes, use LEFT JOINs:

    CREATE OR ALTER VIEW Admin_AllVehicles_V AS
    SELECT
        V.VehicleNo,
        V.[Type],
        V.Make,
        V.Model,
        V.[Year],
        -- Subtype-specific columns (NULL when not applicable)
        C.DoorCount,
        C.TrunkCapacity,
        T.PayloadCapacity,
        T.TowingCapacity
    FROM Vehicle V
    LEFT JOIN Car C ON V.VehicleNo = C.VehicleNo
    LEFT JOIN Truck T ON V.VehicleNo = T.VehicleNo;

The base/subtype pattern means you can query at whatever level of specificity you need — the base for cross-type reports, the subtype for type-specific operations.

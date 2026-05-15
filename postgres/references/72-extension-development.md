# Extension Development

Writing C extensions for PostgreSQL: PGXS Makefile, control file, SQL install scripts, C function anatomy, hooks, background workers, custom scan providers, FDW C-API, archive modules, custom WAL resource managers, logical decoding output plugins, the extension-author surface in PG14 → PG18.

> [!WARNING] PG18 chapter renumbering
> The "Extending SQL" chapter moved from chapter 38 (PG14-16) to **chapter 36** in PG18. The custom WAL resource managers page moved from chapter 66 to chapter 64.2 under a new "Write Ahead Logging for Extensions" grouping. Cite URLs by major version, not chapter number.

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Syntax / Mechanics](#syntax--mechanics)
    - [Extension Layout](#extension-layout)
    - [Control File](#control-file)
    - [PGXS Makefile](#pgxs-makefile)
    - [C Function Anatomy](#c-function-anatomy)
    - [Memory Contexts](#memory-contexts)
    - [Error Handling](#error-handling)
    - [Server Programming Interface (SPI)](#server-programming-interface-spi)
    - [Hooks](#hooks)
    - [Shared Memory](#shared-memory)
    - [Background Workers](#background-workers)
    - [Custom Scan Providers](#custom-scan-providers)
    - [FDW Handler](#fdw-handler)
    - [Logical Decoding Output Plugins](#logical-decoding-output-plugins)
    - [Archive Modules](#archive-modules)
    - [Custom WAL Resource Managers](#custom-wal-resource-managers)
    - [PG18 New Author Surface](#pg18-new-author-surface)
    - [Per-Version Timeline](#per-version-timeline)
- [Examples / Recipes](#examples--recipes)
- [Gotchas / Anti-patterns](#gotchas--anti-patterns)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

You are writing or maintaining a PostgreSQL extension: SQL-only bundle, C-language functions, hook-installing module, background worker, custom scan provider, foreign data wrapper, logical decoding output plugin, archive library, or custom WAL resource manager. Cross-reference [`69-extensions.md`](./69-extensions.md) for the user-facing `CREATE EXTENSION` surface and the trusted-extension model. Cross-reference [`70-fdw.md`](./70-fdw.md) for the FDW user surface (this file covers the C-API author surface).

## Mental Model

Five rules for extension authors:

1. **Extension = `.control` + `.sql` + optional `.so` library.** SQL-only extensions skip the C library. C extensions ship a shared object built via PGXS Makefile. Both must be installed into the PG share directory (or PG18+ `extension_control_path`). `CREATE EXTENSION foo` reads the control file, executes the SQL script, registers the extension in `pg_extension`.[^extend-extensions]

2. **C functions need `PG_FUNCTION_INFO_V1` + `Datum funcname(PG_FUNCTION_ARGS)` signature.** Version-1 calling convention has been the default since PG8.2. Every exported function in your `.so` must declare `PG_FUNCTION_INFO_V1(funcname)` adjacent to the function and use `PG_GETARG_*` / `PG_RETURN_*` macros for argument unwrapping.[^xfunc-c]

3. **PGXS Makefile builds against installed PG, not source tree.** `PG_CONFIG := pg_config` + `PGXS := $(shell $(PG_CONFIG) --pgxs)` + `include $(PGXS)` is the canonical three-line invocation. PGXS reads `pg_config` output, picks the right include paths, compiler flags, install destination. Avoids re-deriving paths.[^pgxs]

4. **Hooks intercept core PG behavior.** Function pointers exported by the backend (e.g., `planner_hook`, `ProcessUtility_hook`, `shmem_request_hook` PG15+, `executor_start_hook`). Set in `_PG_init()` at module load. Convention: chain — save previous hook value, call it from your hook, restore on unload. The backend never resets hooks; once installed, they live for the backend's lifetime.

5. **`PG_MODULE_MAGIC` is mandatory and once per shared object.** It records the PG version + ABI marker. PG18 adds `PG_MODULE_MAGIC_EXT(.name = "foo", .version = "1.2.3")` which extends the magic block to also record the extension's name and version, retrievable via `pg_get_loaded_modules()`. Both are macros that emit a static struct — must appear exactly once at file scope.[^pg18-magic-ext]

> [!WARNING] Hook ordering is your responsibility
> Hooks form a singly-linked chain implicitly through saved-previous-pointer. If you install `planner_hook` you MUST save the previous `planner_hook` value in `_PG_init()` and call it (or the standard planner) from your hook. Forgetting breaks every other extension that installed the same hook later.

## Decision Matrix

| Need | Use | Avoid | Why |
|---|---|---|---|
| Bundle SQL helpers + types | SQL-only extension (control file + .sql) | Loose `\i` scripts | Versioned, `pg_dump`-tracked, drop-cleanly |
| Custom C functions | C extension via PGXS | PL/pgSQL for hot paths | Native speed; access to internal APIs |
| Inspect every DDL command | Event trigger (cross-ref [`40-event-triggers.md`](./40-event-triggers.md)) | ProcessUtility_hook unless audit-style required | Event triggers safer + supported per-database |
| Intercept every query plan | `planner_hook` | Per-query rewrite | Single integration point; chained safely |
| Add custom executor node | Custom scan provider | Plan rewriter abuse | First-class API since PG9.5 |
| Read from non-SQL source | FDW handler (cross-ref [`70-fdw.md`](./70-fdw.md)) | Background worker exporting tables | Standard SQL surface |
| Long-running background task | Background worker | Cron + libpq | In-process, shared-memory access, restartable |
| WAL-replicate custom data | Custom WAL resource manager PG15+ | logical decoding output plugin | Physical-replicate via standard WAL |
| Stream changes to external system | Logical decoding output plugin | FDW round-trip | Async, low-latency, ordered |
| Replace `archive_command` | Archive module PG15+ via `archive_library` | Shell script `archive_command` | In-process; no shell overhead per segment |
| Pluggable storage | Table access method | Heap subclass | First-class API since PG12 |
| Inject test failures | PG18 injection points | `assert(0)` + recompile | Toggleable at runtime via `INJECTION_POINT()` |

Smell signals:

- Writing a `ProcessUtility_hook` to audit DDL → use event triggers instead unless you must run before the catalog change
- Calling out to `system()` from a hook → extension code requires a background worker for out-of-process work
- Linking against `libpq` from inside the backend → use SPI for in-process SQL

## Syntax / Mechanics

### Extension Layout

Canonical layout for a C extension named `myext`:

    myext/
    ├── Makefile
    ├── myext.control
    ├── myext--1.0.sql              # initial install script
    ├── myext--1.0--1.1.sql         # upgrade path 1.0 → 1.1
    ├── myext--1.1.sql              # full install at 1.1 (optional but common)
    ├── myext.c                     # C source
    ├── myext.h
    └── sql/                        # regression tests
        └── basic.sql
    └── expected/
        └── basic.out

`make install` copies:

- `myext.control` → `$SHAREDIR/extension/myext.control`
- `*.sql` → `$SHAREDIR/extension/`
- `myext.so` → `$PKGLIBDIR/myext.so`

`$SHAREDIR` = `pg_config --sharedir`. `$PKGLIBDIR` = `pg_config --pkglibdir`.

PG18+ alternative: install to a custom share directory and set `extension_control_path` in `postgresql.conf` to point at it. Library still goes to `$PKGLIBDIR` (or `dynamic_library_path` GUC).[^pg18-extension-control-path]

### Control File

Plain-text key-value file. Minimum:

    # myext.control
    comment = 'demo extension'
    default_version = '1.1'
    module_pathname = '$libdir/myext'
    relocatable = true

Full set of keys (PG16):

| Key | Required | Default | Meaning |
|---|---|---|---|
| `comment` | no | empty | Description shown in `\dx` |
| `default_version` | yes | — | Version selected if `CREATE EXTENSION foo` (no `VERSION` clause) |
| `module_pathname` | no | — | Substituted for `MODULE_PATHNAME` token in `.sql` scripts |
| `directory` | no | `extension` | Subdirectory of `$SHAREDIR` where install/upgrade scripts live |
| `requires` | no | — | Comma-separated list of required extensions |
| `superuser` | no | true | Pre-PG13: install requires superuser. PG13+: prefer `trusted` flag |
| `trusted` | no | false | PG13+ — non-superuser may install if they have `CREATE` on the database |
| `relocatable` | no | false | Can be moved between schemas via `ALTER EXTENSION SET SCHEMA` |
| `schema` | no | — | Pin to specific schema; mutually exclusive with `relocatable = true` |
| `encoding` | no | — | Restrict to specific database encoding (rare) |
| `no_relocate` | no | — | PG16+ — comma-separated list of required extensions whose schema this extension references via the `@extschema:name@` syntax[^pg16-no-relocate] |

> [!NOTE] PostgreSQL 16
> The `@extschema:referenced_extension_name@` syntax lets your install script reference another extension's schema without hardcoding it. Pair with `no_relocate = required_ext` to prevent the required extension from being relocated after your extension is installed.[^pg16-extschema]

### PGXS Makefile

Minimal three-line invocation:

    # Makefile
    EXTENSION = myext
    MODULE_big = myext
    OBJS = myext.o
    DATA = myext--1.0.sql myext--1.0--1.1.sql myext--1.1.sql

    PG_CONFIG = pg_config
    PGXS := $(shell $(PG_CONFIG) --pgxs)
    include $(PGXS)

Common PGXS variables:

| Variable | Purpose |
|---|---|
| `MODULES` | List of shared objects (one C file each, named `$NAME.c`) |
| `MODULE_big` | Single shared object built from multiple `OBJS` |
| `PROGRAM` | Build a CLI binary (not a `.so`) |
| `EXTENSION` | Names the extension (matches `.control` file) |
| `DATA` | Install scripts and other share-directory files |
| `DATA_built` | DATA files generated at build time |
| `DOCS` | Documentation files |
| `HEADERS` | Header files to install into include directory |
| `HEADERS_built` | Generated headers |
| `SCRIPTS` | Executable scripts to install into bin |
| `REGRESS` | Regression test names (run via `make installcheck`) |
| `REGRESS_OPTS` | Options for `pg_regress` |
| `ISOLATION` | Isolation tester scripts |
| `ISOLATION_OPTS` | Options for `pg_isolation_regress` |
| `TAP_TESTS = 1` | Run Perl TAP tests under `t/` |
| `NO_INSTALL = 1` | Don't install (build-only) |
| `NO_INSTALLCHECK = 1` | Don't run `installcheck` |
| `EXTRA_CLEAN` | Files to remove on `make clean` |
| `PG_CPPFLAGS` | Extra preprocessor flags |
| `PG_CFLAGS` | Extra C compiler flags |
| `PG_CXXFLAGS` | Extra C++ compiler flags |
| `PG_LDFLAGS` | Extra linker flags |
| `PG_LIBS` | Libraries linked into `PROGRAM` |
| `SHLIB_LINK` | Libraries linked into shared module |
| `PG_CONFIG` | Path to `pg_config` (defaults to first in `$PATH`) |

Build + install:

    make
    make install
    make installcheck   # runs regression tests against installed PG

> [!NOTE] PostgreSQL 16
> The Meson build system was added in PG16. PGXS itself remains the canonical extension build system; Meson is for building PostgreSQL from source.[^pg16-meson]

### C Function Anatomy

Minimal C extension exporting one SQL-callable function:

    #include "postgres.h"
    #include "fmgr.h"
    #include "utils/builtins.h"

    PG_MODULE_MAGIC;

    PG_FUNCTION_INFO_V1(myext_add);

    Datum
    myext_add(PG_FUNCTION_ARGS)
    {
        int32 a = PG_GETARG_INT32(0);
        int32 b = PG_GETARG_INT32(1);

        PG_RETURN_INT32(a + b);
    }

SQL install script:

    -- myext--1.0.sql
    CREATE FUNCTION myext_add(int, int)
    RETURNS int
    AS 'MODULE_PATHNAME', 'myext_add'
    LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;

`PG_GETARG_*` macros for common types:

| Macro | SQL type |
|---|---|
| `PG_GETARG_INT16(n)` | smallint |
| `PG_GETARG_INT32(n)` | integer |
| `PG_GETARG_INT64(n)` | bigint |
| `PG_GETARG_FLOAT4(n)` | real |
| `PG_GETARG_FLOAT8(n)` | double precision |
| `PG_GETARG_BOOL(n)` | boolean |
| `PG_GETARG_TEXT_PP(n)` | text (use `VARDATA_ANY` + `VARSIZE_ANY_EXHDR` to access bytes) |
| `PG_GETARG_CSTRING(n)` | cstring (C nul-terminated) |
| `PG_GETARG_ARRAYTYPE_P(n)` | array |
| `PG_GETARG_DATUM(n)` | raw Datum (for custom types) |
| `PG_ARGISNULL(n)` | boolean — true if argument is SQL NULL |

`PG_RETURN_*` mirrors. Plus `PG_RETURN_NULL()` for SQL NULL.

`STRICT` in the SQL declaration skips the C function entirely if any arg is NULL. Without `STRICT`, your C code must check `PG_ARGISNULL(n)` before each `PG_GETARG_*`.

For text return:

    text *result = cstring_to_text("hello");
    PG_RETURN_TEXT_P(result);

For set-returning functions: use `SRF_FIRSTCALL_INIT()` / `SRF_PERCALL_SETUP()` / `SRF_RETURN_NEXT()` / `SRF_RETURN_DONE()` macros, or the more modern `InitMaterializedSRF()` / `tuplestore` API.[^xfunc-c]

> [!NOTE] PostgreSQL 18
> `PG_MODULE_MAGIC_EXT(.name = "myext", .version = "1.2.3")` extends `PG_MODULE_MAGIC` to record the extension name and version in the loaded `.so`. Retrievable cluster-wide via `SELECT * FROM pg_get_loaded_modules()`. Pre-PG18 you can only see the file path of each loaded library.[^pg18-magic-ext]

### Memory Contexts

Every backend operates inside a stack of memory contexts. `palloc(n)` allocates from `CurrentMemoryContext`; `pfree(ptr)` frees a single allocation; `MemoryContextReset(ctx)` frees every allocation in a context at once.

Critical contexts:

| Context | Lifetime | Use |
|---|---|---|
| `CurrentMemoryContext` | Whatever the executor set | Default for `palloc` |
| `TopMemoryContext` | Backend lifetime | Long-lived state, hash tables, hook-installed lookups |
| `CacheMemoryContext` | Backend lifetime | Catalog cache entries |
| `ErrorContext` | Cleared after error recovery | Used during `ereport` cleanup |
| `MessageContext` | Per command from client | Parser/analyzer scratch |
| `PortalContext` | Per portal (cursor) | Plan-execution scratch |
| `TopTransactionContext` | Per top-level transaction | Resets on COMMIT/ROLLBACK |
| `CurTransactionContext` | Per subtransaction | Resets on SAVEPOINT/ROLLBACK TO |

Switch contexts via `MemoryContextSwitchTo(ctx)`. Save the old context, switch, do work, switch back:

    MemoryContext oldcontext = MemoryContextSwitchTo(TopMemoryContext);
    char *long_lived = pstrdup("persists for backend lifetime");
    MemoryContextSwitchTo(oldcontext);

> [!WARNING] palloc never returns NULL on OOM
> palloc raises `ERROR` via `ereport` (which is a `longjmp`) — the call does not return. Do not write `if (palloc(n) == NULL)`. If you need a non-throwing allocator, use `palloc_extended(n, MCXT_ALLOC_NO_OOM)` and check the return value.

### Error Handling

Raise errors with `ereport`:

    if (n < 0)
        ereport(ERROR,
                (errcode(ERRCODE_INVALID_PARAMETER_VALUE),
                 errmsg("argument must be non-negative"),
                 errdetail("got %d", n),
                 errhint("pass a non-negative integer")));

`ERROR` is a `longjmp` — control does not return from `ereport(ERROR, ...)`. Higher levels: `FATAL` (exits backend), `PANIC` (exits postmaster). Lower levels: `WARNING`, `NOTICE`, `INFO`, `LOG`, `DEBUG1` through `DEBUG5` (return normally).

For cleanup on error, use `PG_TRY` / `PG_CATCH` / `PG_END_TRY`:

    PG_TRY();
    {
        // code that may raise ERROR
    }
    PG_CATCH();
    {
        // cleanup
        PG_RE_THROW();
    }
    PG_END_TRY();

Do NOT use `PG_TRY` for application-level retry; the only sane operation in `PG_CATCH` is cleanup followed by re-throw. To recover transaction state, use subtransactions.[^xfunc-c]

### Server Programming Interface (SPI)

SPI lets C functions execute SQL. Connect → execute → disconnect:

    int ret;

    if ((ret = SPI_connect()) != SPI_OK_CONNECT)
        elog(ERROR, "SPI_connect failed: %d", ret);

    ret = SPI_execute("SELECT 1 + 1 AS sum", true, 0);
    if (ret != SPI_OK_SELECT)
        elog(ERROR, "SPI_execute failed: %d", ret);

    if (SPI_processed > 0)
    {
        bool isnull;
        Datum d = SPI_getbinval(SPI_tuptable->vals[0],
                                SPI_tuptable->tupdesc,
                                1, &isnull);
        elog(NOTICE, "got %d", DatumGetInt32(d));
    }

    SPI_finish();

Common SPI functions:

| Function | Purpose |
|---|---|
| `SPI_connect()` | Connect to SPI (must call before any other SPI call) |
| `SPI_finish()` | Disconnect; releases resources |
| `SPI_execute(query, readonly, count)` | Plan + execute SQL; count=0 means all rows |
| `SPI_prepare(query, nargs, argtypes)` | Plan once for repeated execution |
| `SPI_execute_plan(plan, vals, nulls, readonly, count)` | Execute prepared plan with bound parameters |
| `SPI_processed` | Number of rows processed (global after SPI_execute) |
| `SPI_tuptable` | Result tuples (global after SPI_execute) |
| `SPI_getvalue(row, tupdesc, colnum)` | Get column value as cstring |
| `SPI_getbinval(row, tupdesc, colnum, &isnull)` | Get column value as Datum |
| `SPI_cursor_open()` / `SPI_cursor_fetch()` / `SPI_cursor_close()` | Streaming cursor API |

SPI allocates result tuples in a SPI-managed memory context that is freed by `SPI_finish()`. Copy data to your own context if you need it after disconnect.[^spi]

### Hooks

Hooks are global function pointers exported by the backend. To install:

1. Save the previous value in your module-load function `_PG_init`
2. Set the pointer to your callback
3. From your callback, call the previous pointer (if non-NULL) or the standard implementation

Example: `planner_hook`:

    static planner_hook_type prev_planner_hook = NULL;

    static PlannedStmt *
    my_planner(Query *parse, const char *query_string, int cursorOptions,
               ParamListInfo boundParams)
    {
        PlannedStmt *result;

        if (prev_planner_hook)
            result = prev_planner_hook(parse, query_string, cursorOptions, boundParams);
        else
            result = standard_planner(parse, query_string, cursorOptions, boundParams);

        // post-process result here

        return result;
    }

    void _PG_init(void)
    {
        prev_planner_hook = planner_hook;
        planner_hook = my_planner;
    }

Common hooks:

| Hook | Header | Purpose |
|---|---|---|
| `planner_hook` | `optimizer/planner.h` | Replace or wrap the planner |
| `post_parse_analyze_hook` | `parser/analyze.h` | Inspect/modify query after parse-analysis |
| `executor_start_hook` | `executor/executor.h` | Wrap `ExecutorStart` |
| `executor_run_hook` | `executor/executor.h` | Wrap `ExecutorRun` |
| `executor_finish_hook` | `executor/executor.h` | Wrap `ExecutorFinish` |
| `executor_end_hook` | `executor/executor.h` | Wrap `ExecutorEnd` |
| `ProcessUtility_hook` | `tcop/utility.h` | Intercept utility commands (DDL, VACUUM, COPY, etc.) |
| `shmem_request_hook` (PG15+) | `storage/shmem.h` | Request shared memory in postmaster startup |
| `shmem_startup_hook` | `storage/ipc.h` | Initialize shared memory after startup |
| `emit_log_hook` | `utils/elog.h` | Intercept log messages |
| `ClientAuthentication_hook` | `libpq/auth.h` | Pre/post authentication |
| `check_password_hook` | `commands/user.h` | Validate password on `CREATE/ALTER ROLE` |
| `fmgr_hook` | `fmgr.h` | Wrap every function call |
| `needs_fmgr_hook` | `fmgr.h` | Decide if `fmgr_hook` applies to this function |

> [!NOTE] PostgreSQL 15
> The `shmem_request_hook` replaces the pattern of calling `RequestAddinShmemSpace` and `RequestNamedLWLockTranche` directly from `_PG_init`. The old pattern still works in PG15-17 but is deprecated; PG18+ extension authors should use `shmem_request_hook`.

### Shared Memory

For an extension that wants persistent shared state across backends:

1. Set `shared_preload_libraries = 'myext'` in `postgresql.conf` (postmaster context — restart required)
2. Install `shmem_request_hook` to call `RequestAddinShmemSpace(size)` and `RequestNamedLWLockTranche(name, count)` (PG15+)
3. Install `shmem_startup_hook` to call `ShmemInitStruct(name, size, &found)` and initialize the struct if `!found`
4. Use the named LWLock for synchronization

Skeleton (PG15+):

    static shmem_request_hook_type prev_shmem_request_hook = NULL;
    static shmem_startup_hook_type prev_shmem_startup_hook = NULL;

    typedef struct {
        LWLock *lock;
        int64 counter;
    } MyExtState;

    static MyExtState *state = NULL;

    static void
    my_shmem_request(void)
    {
        if (prev_shmem_request_hook)
            prev_shmem_request_hook();

        RequestAddinShmemSpace(sizeof(MyExtState));
        RequestNamedLWLockTranche("myext", 1);
    }

    static void
    my_shmem_startup(void)
    {
        bool found;

        if (prev_shmem_startup_hook)
            prev_shmem_startup_hook();

        state = ShmemInitStruct("myext", sizeof(MyExtState), &found);
        if (!found) {
            state->lock = &(GetNamedLWLockTranche("myext"))->lock;
            state->counter = 0;
        }
    }

    void
    _PG_init(void)
    {
        if (!process_shared_preload_libraries_in_progress)
            ereport(ERROR,
                    (errmsg("myext must be loaded via shared_preload_libraries")));

        prev_shmem_request_hook = shmem_request_hook;
        shmem_request_hook = my_shmem_request;

        prev_shmem_startup_hook = shmem_startup_hook;
        shmem_startup_hook = my_shmem_startup;
    }

> [!WARNING] shared_preload_libraries is postmaster-context
> Changes to `shared_preload_libraries` require a full server restart. `pg_reload_conf()` and `SIGHUP` do not pick it up. Cross-reference [`53-server-configuration.md`](./53-server-configuration.md) gotcha #4.

### Background Workers

Long-running in-process tasks. Register from `_PG_init()` when loaded via `shared_preload_libraries`:

    #include "postmaster/bgworker.h"

    static void
    my_bgworker_main(Datum main_arg)
    {
        // worker body
        BackgroundWorkerUnblockSignals();
        BackgroundWorkerInitializeConnection("postgres", NULL, 0);

        for (;;)
        {
            (void) WaitLatch(MyLatch,
                             WL_LATCH_SET | WL_TIMEOUT | WL_EXIT_ON_PM_DEATH,
                             60000L,
                             PG_WAIT_EXTENSION);
            ResetLatch(MyLatch);

            // do work
        }
    }

    void
    _PG_init(void)
    {
        BackgroundWorker worker;

        memset(&worker, 0, sizeof(BackgroundWorker));
        worker.bgw_flags = BGWORKER_SHMEM_ACCESS | BGWORKER_BACKEND_DATABASE_CONNECTION;
        worker.bgw_start_time = BgWorkerStart_RecoveryFinished;
        worker.bgw_restart_time = 30;  /* seconds; BGW_NEVER_RESTART to disable */
        strcpy(worker.bgw_library_name, "myext");
        strcpy(worker.bgw_function_name, "my_bgworker_main");
        strcpy(worker.bgw_name, "myext worker");
        strcpy(worker.bgw_type, "myext worker");

        RegisterBackgroundWorker(&worker);
    }

Workers count against `max_worker_processes`. Set higher than the sum of all extension workers + parallel-query workers + autovacuum workers. Cross-reference [`63-internals-architecture.md`](./63-internals-architecture.md) for the worker budget formula.[^bgworker]

### Custom Scan Providers

Custom executor nodes. Register a provider, return CustomPath nodes from `set_rel_pathlist_hook`, the planner can pick them based on cost. Used by Citus, TimescaleDB, pg_pathman.

Skeleton:

    static const CustomScanMethods my_scan_methods = {
        .CustomName = "MyCustomScan",
        .CreateCustomScanState = my_create_scan_state
    };

    static const CustomExecMethods my_exec_methods = {
        .CustomName = "MyCustomScan",
        .BeginCustomScan = my_begin_scan,
        .ExecCustomScan = my_exec_scan,
        .EndCustomScan = my_end_scan,
        .ReScanCustomScan = my_rescan_scan
    };

    void _PG_init(void)
    {
        RegisterCustomScanMethods(&my_scan_methods);
        set_rel_pathlist_hook = my_set_rel_pathlist;
    }

> [!NOTE] PostgreSQL 15
> *"Allow custom scan providers to indicate if they support projections (Sven Klemm). The default is now that custom scan providers are assumed to not support projections; those that do will need to be updated for this release."* Set `CUSTOMPATH_SUPPORT_PROJECTION` in the path flags or the planner will add an explicit projection node.[^pg15-custom-scan]

### FDW Handler

Foreign Data Wrappers ship a handler function returning an `FdwRoutine` populated with callbacks. Cross-reference [`70-fdw.md`](./70-fdw.md) for the user surface; this is the C-API summary.

Required callbacks for read-only FDW:

| Callback | Purpose |
|---|---|
| `GetForeignRelSize` | Estimate row count and width |
| `GetForeignPaths` | Generate possible scan paths |
| `GetForeignPlan` | Choose a path; produce a `ForeignScan` plan node |
| `BeginForeignScan` | Per-execution setup |
| `IterateForeignScan` | Return next tuple |
| `ReScanForeignScan` | Reset for re-execution |
| `EndForeignScan` | Cleanup |

For writable FDW, add `AddForeignUpdateTargets`, `PlanForeignModify`, `BeginForeignModify`, `ExecForeignInsert`/`Update`/`Delete`, `ExecForeignBatchInsert` (PG14+), `GetForeignModifyBatchSize` (PG14+), `EndForeignModify`. For TRUNCATE (PG14+), add `ExecForeignTruncate`. For async (PG14+), add `IsForeignScanParallelSafe`, `ForeignAsyncRequest`, `ForeignAsyncConfigureWait`, `ForeignAsyncNotify`.[^fdw-handler]

### Logical Decoding Output Plugins

Translate WAL records into a wire format. `pgoutput` (built-in, used by logical replication) and `test_decoding` (built-in test) are reference implementations. Third-party plugins: `wal2json`, `decoderbufs`.

Callbacks an output plugin defines:

| Callback | Required | Purpose |
|---|---|---|
| `startup_cb` | yes | One-time setup |
| `shutdown_cb` | no | Cleanup |
| `begin_cb` | yes | Begin transaction |
| `change_cb` | yes | Per-row INSERT/UPDATE/DELETE |
| `commit_cb` | yes | Commit transaction |
| `filter_by_origin_cb` | no | Filter by replication origin (cross-ref [`74-logical-replication.md`](./74-logical-replication.md)) |
| `truncate_cb` | no | TRUNCATE events |
| `message_cb` | no | Generic logical messages from `pg_logical_emit_message()` |
| `stream_start_cb` / `stream_stop_cb` / `stream_abort_cb` / `stream_commit_cb` / `stream_change_cb` / `stream_message_cb` / `stream_truncate_cb` | no | PG14+ streaming of in-progress transactions |

Plugin exports an `_PG_output_plugin_init` function that populates an `OutputPluginCallbacks` struct.[^output-plugin]

### Archive Modules

> [!NOTE] PostgreSQL 15
> *"Allow archiving via loadable modules (Nathan Bossart). Previously, archiving was only done by calling shell commands. The new server variable `archive_library` can be set to specify a library to be called for archiving."*

> [!NOTE] PostgreSQL 16
> *"Redesign archive modules to be more flexible (Nathan Bossart). Initialization changes will require modules written for older versions of Postgres to be updated."* PG15 archive modules must be rewritten for PG16.

PG16+ archive module skeleton:

    #include "archive/archive_module.h"

    static const ArchiveModuleCallbacks my_archive_callbacks = {
        .startup_cb = my_startup,
        .check_configured_cb = my_check_configured,
        .archive_file_cb = my_archive_file,
        .shutdown_cb = my_shutdown
    };

    const ArchiveModuleCallbacks *
    _PG_archive_module_init(void)
    {
        return &my_archive_callbacks;
    }

Set `archive_library = 'my_archive_module'` and `archive_mode = on`. The module's `archive_file_cb` is called for each completed WAL segment.[^archive-modules]

### Custom WAL Resource Managers

> [!NOTE] PostgreSQL 15
> *"Allow extensions to define custom WAL resource managers (Jeff Davis).*"

An extension can register its own WAL resource manager (rmgr) with a unique ID in the range `RM_EXPERIMENTAL_ID` to `RM_MAX_ID` (128-255). The rmgr's `rm_redo` function is called during WAL replay. Useful for extensions that want their own WAL records (e.g., custom index AMs, custom heap AMs).

Skeleton:

    static RmgrData my_rmgr = {
        .rm_name = "my_custom_rmgr",
        .rm_redo = my_redo,
        .rm_desc = my_desc,
        .rm_identify = my_identify
    };

    void
    _PG_init(void)
    {
        RegisterCustomRmgr(MY_CUSTOM_RM_ID, &my_rmgr);
    }

`MY_CUSTOM_RM_ID` is an integer in the experimental range; collisions across loaded extensions cause `RegisterCustomRmgr` to error out. Use [https://wiki.postgresql.org/wiki/CustomWALResourceManagers](https://wiki.postgresql.org/wiki/CustomWALResourceManagers) to claim a unique ID.[^pg15-custom-rmgr]

### PG18 New Author Surface

PG18 added five categories of new extension-author surface area:

| Feature | Macro/Function | Notes |
|---|---|---|
| Module identity in magic block | `PG_MODULE_MAGIC_EXT(.name, .version)` | Replaces `PG_MODULE_MAGIC`; backwards-compatible |
| Loaded-module introspection | `pg_get_loaded_modules()` | SQL function; returns name, version, path |
| Custom EXPLAIN options | `RegisterExtensionExplainOption()` | Add user-visible EXPLAIN flags |
| Custom cumulative statistics | `pgstat_register_kind()` | Register a new statistics kind |
| Injection points | `INJECTION_POINT()` / `INJECTION_POINT_LOAD()` / `INJECTION_POINT_CACHED()` / `IS_INJECTION_POINT_ATTACHED()` | Toggleable test hooks, no recompile |
| Custom wait events | `WaitEventExtensionNew(const char *wait_event_name)` | PG17+ — surface custom waits in `pg_stat_activity` |
| Extension control path | `extension_control_path` GUC | Search path for `.control` files |

PG_MODULE_MAGIC_EXT syntax (named-parameter, C99 designated initializers):

    PG_MODULE_MAGIC_EXT(
        .name = "myext",
        .version = "1.2.3"
    );

Custom wait event (PG17+):

    static uint32 my_wait_event = 0;

    void
    _PG_init(void)
    {
        my_wait_event = WaitEventExtensionNew("MyExtensionWait");
    }

    // Inside a hot path:
    pgstat_report_wait_start(my_wait_event);
    // ... do thing that might wait ...
    pgstat_report_wait_end();

Inspected via `SELECT pid, wait_event_type, wait_event FROM pg_stat_activity WHERE wait_event_type = 'Extension';`[^pg17-wait-events]

Injection point (PG18 enhanced):

    INJECTION_POINT("my-test-hook");

At runtime: `SELECT injection_points_attach('my-test-hook', 'wait');` makes the next backend hitting that line wait until detached.

### Per-Version Timeline

| Version | Extension-author change |
|---|---|
| PG14 | `amadjustmembers` for index AM API; extensible subscripting; FDW: async parallel scans, batch INSERT (`ExecForeignBatchInsert` + `GetForeignModifyBatchSize`), TRUNCATE (`ExecForeignTruncate`), `postgres_fdw_get_connections()` |
| PG15 | `archive_library` + archive modules; custom WAL resource managers (`RegisterCustomRmgr`); custom backup targets; `shmem_request_hook`; ABI identifier in magic block; Windows `PGDLLIMPORT` for all globals; custom scan projection breaking change |
| PG16 | Symbol visibility default-hide (`PGDLLEXPORT` required); `@extschema:name@` syntax; `no_relocate`; archive modules redesigned (PG15 modules must be rewritten); Meson build system |
| PG17 | Custom wait events for extensions (`WaitEventExtensionNew`); `ALTER OPERATOR` more attributes; FDW non-join push-down API; `adminpack` removed; `pg_dump --exclude-extension` |
| PG18 | `PG_MODULE_MAGIC_EXT` + `pg_get_loaded_modules()`; `extension_control_path` GUC; injection points enhanced (`INJECTION_POINT_LOAD`, `INJECTION_POINT_CACHED`, `IS_INJECTION_POINT_ATTACHED`); custom EXPLAIN options; custom cumulative statistics API; chapter renumbered 38 → 36 |

## Examples / Recipes

### Recipe 1: Minimal SQL-only extension

Two-table contact-book extension, no C code.

`contactbook.control`:

    comment = 'contact book demo'
    default_version = '1.0'
    relocatable = true

`contactbook--1.0.sql`:

    CREATE TABLE contact (
        id bigserial PRIMARY KEY,
        name text NOT NULL,
        email citext UNIQUE
    );

    CREATE FUNCTION contact_count() RETURNS bigint
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$ SELECT count(*) FROM contact $$;

`Makefile`:

    EXTENSION = contactbook
    DATA = contactbook--1.0.sql

    PG_CONFIG = pg_config
    PGXS := $(shell $(PG_CONFIG) --pgxs)
    include $(PGXS)

Install: `sudo make install`. In SQL: `CREATE EXTENSION contactbook;`

### Recipe 2: Minimal C extension with one function

`Makefile`:

    EXTENSION = myadd
    MODULE_big = myadd
    OBJS = myadd.o
    DATA = myadd--1.0.sql

    PG_CONFIG = pg_config
    PGXS := $(shell $(PG_CONFIG) --pgxs)
    include $(PGXS)

`myadd.c`:

    #include "postgres.h"
    #include "fmgr.h"

    PG_MODULE_MAGIC;

    PG_FUNCTION_INFO_V1(myadd_int);

    Datum
    myadd_int(PG_FUNCTION_ARGS)
    {
        int32 a = PG_GETARG_INT32(0);
        int32 b = PG_GETARG_INT32(1);
        PG_RETURN_INT32(a + b);
    }

`myadd--1.0.sql`:

    CREATE FUNCTION myadd_int(int, int)
    RETURNS int
    AS 'MODULE_PATHNAME', 'myadd_int'
    LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;

`myadd.control`:

    comment = 'integer add demo'
    default_version = '1.0'
    module_pathname = '$libdir/myadd'
    relocatable = true

### Recipe 3: Upgrade script

When releasing 1.1 with a new function:

`myadd--1.0--1.1.sql` (the upgrade path):

    CREATE FUNCTION myadd_bigint(bigint, bigint)
    RETURNS bigint
    AS 'MODULE_PATHNAME', 'myadd_bigint'
    LANGUAGE C IMMUTABLE STRICT PARALLEL SAFE;

`myadd--1.1.sql` (the new full install, for fresh `CREATE EXTENSION`):

    -- copy contents of 1.0 plus the new function

Update `myadd.control`:

    default_version = '1.1'

User invocation:

    -- fresh install:
    CREATE EXTENSION myadd;          -- installs 1.1

    -- upgrade existing 1.0 installation:
    ALTER EXTENSION myadd UPDATE TO '1.1';

### Recipe 4: Hook installation in _PG_init

Track every query's plan time. Load via `shared_preload_libraries = 'plantracker'`.

    #include "postgres.h"
    #include "fmgr.h"
    #include "optimizer/planner.h"
    #include "utils/elog.h"

    PG_MODULE_MAGIC;

    static planner_hook_type prev_planner_hook = NULL;

    static PlannedStmt *
    plantracker_planner(Query *parse, const char *query_string,
                        int cursorOptions, ParamListInfo boundParams)
    {
        instr_time start, end;
        PlannedStmt *result;
        double elapsed_ms;

        INSTR_TIME_SET_CURRENT(start);

        if (prev_planner_hook)
            result = prev_planner_hook(parse, query_string, cursorOptions, boundParams);
        else
            result = standard_planner(parse, query_string, cursorOptions, boundParams);

        INSTR_TIME_SET_CURRENT(end);
        INSTR_TIME_SUBTRACT(end, start);
        elapsed_ms = INSTR_TIME_GET_MILLISEC(end);

        if (elapsed_ms > 100.0)
            ereport(LOG,
                    (errmsg("plantracker: slow plan %.1f ms for %s",
                            elapsed_ms, query_string ? query_string : "<no source>")));

        return result;
    }

    void
    _PG_init(void)
    {
        prev_planner_hook = planner_hook;
        planner_hook = plantracker_planner;
    }

`postgresql.conf`:

    shared_preload_libraries = 'plantracker'

Restart required. `pg_reload_conf()` does not pick this up.

### Recipe 5: Background worker writing to a table

`heartbeat.c`:

    #include "postgres.h"
    #include "fmgr.h"
    #include "postmaster/bgworker.h"
    #include "storage/ipc.h"
    #include "storage/latch.h"
    #include "miscadmin.h"
    #include "executor/spi.h"
    #include "utils/snapmgr.h"
    #include "access/xact.h"

    PG_MODULE_MAGIC;

    void heartbeat_main(Datum) pg_attribute_noreturn();

    void
    heartbeat_main(Datum main_arg)
    {
        BackgroundWorkerUnblockSignals();
        BackgroundWorkerInitializeConnection("postgres", NULL, 0);

        for (;;)
        {
            int rc;

            rc = WaitLatch(MyLatch,
                           WL_LATCH_SET | WL_TIMEOUT | WL_EXIT_ON_PM_DEATH,
                           60000L,
                           PG_WAIT_EXTENSION);
            ResetLatch(MyLatch);

            if (rc & WL_POSTMASTER_DEATH)
                proc_exit(1);

            StartTransactionCommand();
            SPI_connect();
            PushActiveSnapshot(GetTransactionSnapshot());
            SPI_execute("INSERT INTO heartbeat (ts) VALUES (now())", false, 0);
            SPI_finish();
            PopActiveSnapshot();
            CommitTransactionCommand();
        }
    }

    void
    _PG_init(void)
    {
        BackgroundWorker worker;

        memset(&worker, 0, sizeof(BackgroundWorker));
        worker.bgw_flags = BGWORKER_SHMEM_ACCESS | BGWORKER_BACKEND_DATABASE_CONNECTION;
        worker.bgw_start_time = BgWorkerStart_RecoveryFinished;
        worker.bgw_restart_time = 30;
        strcpy(worker.bgw_library_name, "heartbeat");
        strcpy(worker.bgw_function_name, "heartbeat_main");
        strcpy(worker.bgw_name, "heartbeat");
        strcpy(worker.bgw_type, "heartbeat");

        RegisterBackgroundWorker(&worker);
    }

### Recipe 6: PG18 PG_MODULE_MAGIC_EXT + pg_get_loaded_modules

Replace `PG_MODULE_MAGIC` with `PG_MODULE_MAGIC_EXT`:

    PG_MODULE_MAGIC_EXT(
        .name = "heartbeat",
        .version = "1.0.0"
    );

After installation and load:

    SELECT module_name, version, file_name
    FROM pg_get_loaded_modules()
    WHERE module_name = 'heartbeat';

     module_name | version |     file_name
    -------------+---------+----------------------
     heartbeat   | 1.0.0   | $libdir/heartbeat.so

Pre-PG18 you only see `file_name` via `pg_get_loaded_modules` (and the function returned only one column).

### Recipe 7: Trusted extension

Add `trusted = true` to the control file:

    # myext.control
    comment = 'trusted demo'
    default_version = '1.0'
    relocatable = true
    trusted = true

Non-superusers with `CREATE` on the database can now install via `CREATE EXTENSION myext;`. The script runs as the bootstrap superuser; cross-reference [`69-extensions.md`](./69-extensions.md) for the security implications.[^pg13-trusted]

### Recipe 8: Custom wait event (PG17+)

    #include "utils/wait_event.h"

    static uint32 my_wait_event = 0;

    void
    _PG_init(void)
    {
        my_wait_event = WaitEventExtensionNew("MyExtensionFetch");
    }

    void
    do_fetch(void)
    {
        pgstat_report_wait_start(my_wait_event);
        // simulate I/O that should be visible in monitoring
        pg_usleep(100000);  // 100 ms
        pgstat_report_wait_end();
    }

Monitor via:

    SELECT pid, wait_event_type, wait_event
    FROM pg_stat_activity
    WHERE wait_event_type = 'Extension';

Pre-PG17 there was no way for an extension to register custom wait events; backends in extension code showed as `wait_event_type` NULL or generic `IPC`/`LWLock`.

### Recipe 9: Inspect loaded modules

    -- PG18+
    SELECT * FROM pg_get_loaded_modules();

     module_name |  version  |               file_name
    -------------+-----------+----------------------------------------
     myext       | 1.2.3     | $libdir/myext.so
     pgaudit     | 16.0      | $libdir/pgaudit.so
     pg_cron     | 1.6.0     | $libdir/pg_cron.so

Pre-PG18: `pg_get_loaded_modules()` did not exist. Use `lsof -p <postmaster-pid> | grep '\.so$'` from the OS instead, or for shared_preload_libraries-loaded modules `SHOW shared_preload_libraries;`.

### Recipe 10: Regression tests via PGXS

`Makefile`:

    REGRESS = basic
    REGRESS_OPTS = --inputdir=test --outputdir=test

`test/sql/basic.sql`:

    CREATE EXTENSION myadd;
    SELECT myadd_int(2, 3);
    SELECT myadd_int(NULL, 3);

`test/expected/basic.out`:

    CREATE EXTENSION myadd;
    SELECT myadd_int(2, 3);
     myadd_int
    -----------
             5
    (1 row)

    SELECT myadd_int(NULL, 3);
     myadd_int
    -----------

    (1 row)

Run via `make installcheck PGUSER=postgres`.

### Recipe 11: Memory-context discipline for set-returning function

    PG_FUNCTION_INFO_V1(myext_generate);

    Datum
    myext_generate(PG_FUNCTION_ARGS)
    {
        FuncCallContext *funcctx;
        int call_cntr;
        int max_calls;

        if (SRF_IS_FIRSTCALL())
        {
            MemoryContext oldcontext;

            funcctx = SRF_FIRSTCALL_INIT();
            oldcontext = MemoryContextSwitchTo(funcctx->multi_call_memory_ctx);

            funcctx->max_calls = PG_GETARG_INT32(0);
            funcctx->user_fctx = NULL;

            MemoryContextSwitchTo(oldcontext);
        }

        funcctx = SRF_PERCALL_SETUP();
        call_cntr = funcctx->call_cntr;
        max_calls = funcctx->max_calls;

        if (call_cntr < max_calls)
            SRF_RETURN_NEXT(funcctx, Int32GetDatum(call_cntr * 2));
        else
            SRF_RETURN_DONE(funcctx);
    }

`multi_call_memory_ctx` lives for the entire scan; allocations there survive across `SRF_RETURN_NEXT` calls. Allocations in `CurrentMemoryContext` may be freed between calls.

### Recipe 12: Detect extensions referencing private internals

After upgrading PG major versions, audit which loaded modules might reference internals that changed:

    -- PG18+
    SELECT module_name, version, file_name
    FROM pg_get_loaded_modules()
    WHERE module_name NOT IN (
        'plpgsql',  -- core
        'pg_stat_statements',
        'pgaudit'
    );

For each unknown module, check upstream for a release compatible with your new PG major. Cross-reference [`86-pg-upgrade.md`](./86-pg-upgrade.md) for the pre-upgrade extension audit.

### Recipe 13: Linking against a system library

For an extension that needs `libcurl`:

`Makefile`:

    EXTENSION = myhttp
    MODULE_big = myhttp
    OBJS = myhttp.o

    SHLIB_LINK += $(shell pkg-config --libs libcurl)
    PG_CPPFLAGS += $(shell pkg-config --cflags libcurl)

    PG_CONFIG = pg_config
    PGXS := $(shell $(PG_CONFIG) --pgxs)
    include $(PGXS)

> [!WARNING] Linking against libpq from inside the backend
> Do not link a backend extension against `libpq`. Use SPI for in-process SQL. `libpq` from inside the backend bypasses transaction state, opens a new connection on every call, and forks the postmaster from inside itself if connecting to the same cluster — all wrong.

### Recipe 14: PG16 symbol visibility — adding PGDLLEXPORT

A function called by other extensions must be marked exportable on Windows (and now on all platforms since PG16):

    #include "postgres.h"
    #include "fmgr.h"

    PG_MODULE_MAGIC;

    /* PUBLIC API: callable from other extensions */
    PGDLLEXPORT extern void myext_register_callback(void (*cb)(void));

    void
    myext_register_callback(void (*cb)(void))
    {
        // ...
    }

Pre-PG16 on Linux, all global symbols were exported by default. PG16 changed the default; you now need `PGDLLEXPORT` everywhere a function should be callable from outside its own `.so`.[^pg16-visibility]

### Recipe 15: Cross-version build with PG_CONFIG

Build against a specific PG version when multiple are installed:

    make PG_CONFIG=/usr/pgsql-16/bin/pg_config
    sudo make install PG_CONFIG=/usr/pgsql-16/bin/pg_config

Avoids picking up whatever `pg_config` is in `$PATH`. Critical when packaging for multiple PG versions.

## Gotchas / Anti-patterns

1. **`PG_MODULE_MAGIC` mandatory and once per `.so`.** Forgetting causes `incompatible library` errors at `LOAD`. Defining it twice causes link errors.

2. **`shared_preload_libraries` requires restart.** Cannot reload; the postmaster must restart to pick up changes. Cross-reference [`53-server-configuration.md`](./53-server-configuration.md) gotcha #4.

3. **`_PG_init` runs once per backend.** If loaded lazily (without `shared_preload_libraries`), runs on first call into your `.so`. If preloaded, runs in the postmaster and is inherited via `fork()` into every backend.

4. **`palloc` never returns NULL on OOM.** It raises `ERROR` via `longjmp`. Do not check the return value for NULL.

5. **`ereport(ERROR, ...)` is `longjmp`.** Code after the call does not execute. Place cleanup in `PG_TRY/PG_CATCH/PG_END_TRY` if it must run.

6. **PG16 symbol visibility default-hide.** Functions callable from other extensions or the core backend must be marked `PGDLLEXPORT`. Pre-PG16 code that relied on default-visible Linux symbols will not link cleanly on PG16+.[^pg16-visibility]

7. **PG15 archive modules incompatible with PG16+.** The archive module API was redesigned. PG15-targeted modules must be ported.

8. **PG15 custom scan providers default-no-projection.** *"Custom scan providers are assumed to not support projections; those that do will need to be updated for this release."*[^pg15-custom-scan] Set the flag explicitly.

9. **Hook chaining is the author's responsibility.** Always save the previous hook value and call it. Forgetting breaks every other extension installing the same hook later.

10. **`shmem_request_hook` is PG15+.** Pre-PG15, call `RequestAddinShmemSpace` and `RequestNamedLWLockTranche` directly from `_PG_init`. PG15+ deprecates the old pattern.

11. **Custom WAL resource manager IDs collide.** `RegisterCustomRmgr` errors if two extensions claim the same ID. Use the wiki page [https://wiki.postgresql.org/wiki/CustomWALResourceManagers](https://wiki.postgresql.org/wiki/CustomWALResourceManagers) to claim a unique ID.

12. **Subscripting is extensible since PG14.** Pre-PG14 extensions cannot register custom subscript handlers.[^pg14-subscripting]

13. **PG14 FDW async-execution callbacks are opt-in.** A pre-PG14 FDW won't gain async parallel scans automatically; add the new callbacks.

14. **`PG_MODULE_MAGIC_EXT` is PG18+.** Pre-PG18 only `PG_MODULE_MAGIC` (no name/version metadata). `pg_get_loaded_modules()` does not exist pre-PG18.

15. **`extension_control_path` PG18+ does not affect library search path.** Libraries still load from `$PKGLIBDIR` or `dynamic_library_path`. The GUC only affects `.control` file lookup.

16. **Custom wait events are PG17+.** Pre-PG17, extensions either reused existing wait events (misleading in monitoring) or appeared as no-wait in `pg_stat_activity`.

17. **PGXS builds against installed PG, not source.** `pg_config` must point at the right installation. Multiple PG versions installed → multiple `pg_config` binaries → pick the right one explicitly.

18. **Meson build (PG16+) is for building Postgres itself, not your extension.** Use PGXS for your extension regardless of how PG was built.

19. **ABI vs API.** Minor releases (e.g., 16.1 → 16.5) preserve ABI. Major releases (16.x → 17.x) typically break ABI; rebuild the extension. The PG15 ABI identifier in the magic block catches mismatched-distribution loads at `LOAD` time.[^pg15-abi]

20. **`SET search_path` from inside the C function is not free.** It allocates and pushes a search-path stack entry. For functions called millions of times, prefer pinning at the SQL declaration level (`SET search_path = pg_catalog` on the function).

21. **`PG_TRY/PG_CATCH` is for cleanup, not recovery.** The only sane action in `PG_CATCH` is to free resources and `PG_RE_THROW()`. To recover transaction state, use subtransactions via `BeginInternalSubTransaction()` / `ReleaseCurrentSubTransaction()` / `RollbackAndReleaseCurrentSubTransaction()`.

22. **Background workers count against `max_worker_processes`.** A cluster with three extensions each spawning two workers + `max_parallel_workers = 8` + `autovacuum_max_workers = 3` needs `max_worker_processes >= 17`. Cross-reference [`63-internals-architecture.md`](./63-internals-architecture.md).

23. **`bgw_library_name` must match the `.so` basename without extension.** `myext` not `myext.so` not `$libdir/myext`. Same for `bgw_function_name` — symbol name only, no quoting.

## See Also

- [`05-views.md`](./05-views.md) — view-rewriting interaction with `ProcessUtility_hook`
- [`08-plpgsql.md`](./08-plpgsql.md) — PL/pgSQL extension model contrast
- [`14-data-types-builtin.md`](./14-data-types-builtin.md) — Datum representation reference
- [`32-buffer-manager.md`](./32-buffer-manager.md) — shared memory regions extensions interact with
- [`33-wal.md`](./33-wal.md) — WAL infrastructure that custom rmgrs hook into
- [`40-event-triggers.md`](./40-event-triggers.md) — event triggers as an alternative to ProcessUtility_hook
- [`46-roles-privileges.md`](./46-roles-privileges.md) — trusted-extension privilege model
- [`53-server-configuration.md`](./53-server-configuration.md) — `shared_preload_libraries` postmaster context
- [`58-performance-diagnostics.md`](./58-performance-diagnostics.md) — custom wait events surface in pg_stat_activity
- [`60-parallel-query.md`](./60-parallel-query.md) — PARALLEL SAFE/RESTRICTED/UNSAFE markers on C functions
- [`63-internals-architecture.md`](./63-internals-architecture.md) — process model + worker budget
- [`69-extensions.md`](./69-extensions.md) — user-facing CREATE/ALTER/DROP EXTENSION + contrib inventory
- [`70-fdw.md`](./70-fdw.md) — FDW user surface
- [`74-logical-replication.md`](./74-logical-replication.md) — output plugins consumed by logical replication
- [`76-logical-decoding.md`](./76-logical-decoding.md) — output plugin author surface (sibling to this file)
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — extension preflight before major-version upgrade

## Sources

[^extend-extensions]: PG16 docs, "Packaging Related Objects into an Extension." [https://www.postgresql.org/docs/16/extend-extensions.html](https://www.postgresql.org/docs/16/extend-extensions.html)

[^xfunc-c]: PG16 docs, "C-Language Functions." [https://www.postgresql.org/docs/16/xfunc-c.html](https://www.postgresql.org/docs/16/xfunc-c.html)

[^pgxs]: PG16 docs, "Extension Building Infrastructure (PGXS)." [https://www.postgresql.org/docs/16/extend-pgxs.html](https://www.postgresql.org/docs/16/extend-pgxs.html)

[^spi]: PG16 docs, "Server Programming Interface." [https://www.postgresql.org/docs/16/spi.html](https://www.postgresql.org/docs/16/spi.html)

[^bgworker]: PG16 docs, "Background Worker Processes." [https://www.postgresql.org/docs/16/bgworker.html](https://www.postgresql.org/docs/16/bgworker.html)

[^fdw-handler]: PG16 docs, "Writing a Foreign Data Wrapper." [https://www.postgresql.org/docs/16/fdwhandler.html](https://www.postgresql.org/docs/16/fdwhandler.html)

[^output-plugin]: PG16 docs, "Logical Decoding Output Plugins." [https://www.postgresql.org/docs/16/logical-replication-output-plugin.html](https://www.postgresql.org/docs/16/logical-replication-output-plugin.html)

[^archive-modules]: PG16 docs, "Archive Modules." [https://www.postgresql.org/docs/16/archive-modules.html](https://www.postgresql.org/docs/16/archive-modules.html)

[^pg13-trusted]: PG13 release notes — *"Allow some standard extensions to be installed by users with only CREATE privilege on the database."* [https://www.postgresql.org/docs/release/13.0/](https://www.postgresql.org/docs/release/13.0/)

[^pg14-subscripting]: PG14 release notes — *"Allow extensions and built-in data types to implement subscripting (Dmitry Dolgov). Previously subscript handling was hard-coded into the server, so that subscripting could only be applied to array types."* [https://www.postgresql.org/docs/release/14.0/](https://www.postgresql.org/docs/release/14.0/)

[^pg15-custom-rmgr]: PG15 release notes — *"Allow extensions to define custom WAL resource managers (Jeff Davis)."* [https://www.postgresql.org/docs/release/15.0/](https://www.postgresql.org/docs/release/15.0/). Custom rmgr page: [https://www.postgresql.org/docs/16/custom-rmgr.html](https://www.postgresql.org/docs/16/custom-rmgr.html)

[^pg15-custom-scan]: PG15 release notes — *"Allow custom scan providers to indicate if they support projections (Sven Klemm). The default is now that custom scan providers are assumed to not support projections; those that do will need to be updated for this release."* [https://www.postgresql.org/docs/release/15.0/](https://www.postgresql.org/docs/release/15.0/)

[^pg15-abi]: PG15 release notes — *"Add an ABI identifier field to the magic block in loadable libraries, allowing non-community PostgreSQL distributions to identify libraries that are not compatible with other builds (Peter Eisentraut). An ABI field mismatch will generate an error at load time."* [https://www.postgresql.org/docs/release/15.0/](https://www.postgresql.org/docs/release/15.0/)

[^pg16-visibility]: PG16 release notes — *"Prevent extension libraries from exporting their symbols by default (Andres Freund, Tom Lane). Functions that need to be called from the core backend or other extensions must now be explicitly marked PGDLLEXPORT."* [https://www.postgresql.org/docs/release/16.0/](https://www.postgresql.org/docs/release/16.0/)

[^pg16-extschema]: PG16 release notes — *"Allow the schemas of required extensions to be referenced in extension scripts using the new syntax `@extschema:referenced_extension_name@` (Regina Obe)."* [https://www.postgresql.org/docs/release/16.0/](https://www.postgresql.org/docs/release/16.0/)

[^pg16-no-relocate]: PG16 release notes — *"Allow required extensions to be marked as non-relocatable using no_relocate (Regina Obe)."* [https://www.postgresql.org/docs/release/16.0/](https://www.postgresql.org/docs/release/16.0/)

[^pg16-meson]: PG16 release notes — *"Add meson build system (Andres Freund, Nazir Bilal Yavuz, Peter Eisentraut)."* [https://www.postgresql.org/docs/release/16.0/](https://www.postgresql.org/docs/release/16.0/)

[^pg17-wait-events]: PG17 release notes — *"Allow extensions to define custom wait events (Masahiro Ikeda). Custom wait events have been added to postgres_fdw and dblink."* [https://www.postgresql.org/docs/release/17.0/](https://www.postgresql.org/docs/release/17.0/)

[^pg18-magic-ext]: PG18 release notes — *"Add macro PG_MODULE_MAGIC_EXT to allow extensions to report their name and version (Andrei Lepikhov). This information can be accessed via the new function pg_get_loaded_modules()."* [https://www.postgresql.org/docs/release/18.0/](https://www.postgresql.org/docs/release/18.0/). PG18 C-Language Functions chapter documents the macro: [https://www.postgresql.org/docs/18/xfunc-c.html](https://www.postgresql.org/docs/18/xfunc-c.html)

[^pg18-extension-control-path]: PG18 release notes — *"Add server variable extension_control_path to specify the location of extension control files (Peter Eisentraut, Matheus Alcantara)."* [https://www.postgresql.org/docs/release/18.0/](https://www.postgresql.org/docs/release/18.0/). GUC documented at: [https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-EXTENSION-CONTROL-PATH](https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-EXTENSION-CONTROL-PATH)

# Core API Reference


## Command Execution: `$`

The `$` template literal function is the primary way to run shell commands.

    import { $ } from 'zx/core';

    // Basic command
    const result = await $`ls -la`;

    // Interpolation is auto-escaped (safe from injection)
    const file = 'my file with spaces.txt';
    await $`cat ${file}`;  // runs: cat 'my file with spaces.txt'

    // Arrays expand as separate arguments
    const flags = ['--verbose', '--color=auto'];
    await $`ls ${flags}`;  // runs: ls '--verbose' '--color=auto'

    // Synchronous execution
    const out = $.sync`pwd`;

### Configuration Presets

Create custom `$` instances with preset options:

    // Quiet, no-throw variant
    const $q = $({ quiet: true, nothrow: true });
    const result = await $q`grep pattern file.txt`;

    // Scoped to directory
    const $src = $({ cwd: './src' });
    await $src`ls`;

    // Chainable
    const $silent = $({ verbose: false })({ quiet: true });

### All `$` Options

| Option | Type | Description |
|--------|------|-------------|
| `cwd` | `string` | Working directory for command |
| `env` | `Record<string, string>` | Environment variables |
| `input` | `string \| Buffer \| Readable \| ProcessOutput` | Stdin input |
| `timeout` | `string` | Auto-kill duration (e.g., `'10s'`, `'1m'`) |
| `timeoutSignal` | `NodeJS.Signals` | Signal sent on timeout (default: SIGTERM) |
| `signal` | `AbortSignal` | External abort signal |
| `nothrow` | `boolean` | Don't throw on non-zero exit |
| `quiet` | `boolean` | Suppress stdout/stderr printing |
| `verbose` | `boolean` | Print command before execution |
| `sync` | `boolean` | Run synchronously |
| `shell` | `string` | Shell binary path |
| `detached` | `boolean` | Run detached from parent |
| `preferLocal` | `boolean` | Prefer `node_modules/.bin` binaries |
| `prefix` | `string` | Prepend to every command (e.g., `'set -e;'`) |
| `postfix` | `string` | Append to every command |
| `stdio` | `StdioOptions` | Standard I/O configuration |
| `halt` | `boolean` | Create process in halted state |


## ProcessPromise

The return value of `` $`...` `` before `await`.

### Output Methods

    const p = $`command`;

    const text = await p.text();       // stdout as string
    const json = await p.json();       // stdout parsed as JSON
    const lines = await p.lines();     // stdout as string[]
    const buf = await p.buffer();      // stdout as Buffer
    const code = await p.exitCode;     // just the exit code (no throw)

### Process Control

    // Kill
    const p = $`long-running-server`;
    setTimeout(() => p.kill(), 5000);
    // or with signal
    p.kill('SIGKILL');

    // Abort via controller
    const ac = new AbortController();
    const p = $({ signal: ac.signal })`sleep 100`;
    ac.abort();

    // Timeout
    const p = $`slow-command`.timeout('5s');

    // Suppress throw on this specific command
    const result = await $`grep missing file.txt`.nothrow();
    if (result.exitCode !== 0) {
        console.log('Not found');
    }

### Halted Processes

    const p = $({ halt: true })`server start`;
    // ... do setup ...
    p.run();  // manually start
    await p;

### Async Iteration (Streaming Output)

    for await (const line of $`tail -f /var/log/app.log`) {
        if (line.includes('ERROR')) {
            console.log(chalk.red(line));
        }
    }


## ProcessOutput

The resolved value of an awaited `$` command.

    const output = await $`echo hello`;

    output.stdout;     // "hello\n"
    output.stderr;     // ""
    output.exitCode;   // 0
    output.signal;     // null
    output.text();     // "hello\n"
    output.lines();    // ["hello"]
    output.json();     // parse stdout as JSON
    output.buffer();   // Buffer
    output.toString(); // stdout + stderr combined
    output.valueOf();  // toString().trim()

When a command fails (non-zero exit), `ProcessOutput` is thrown as an error:

    try {
        await $`exit 1`;
    } catch (e) {
        e.exitCode;  // 1
        e.stderr;    // error output
        e.message;   // includes command, stdout, stderr
    }


## Piping

### Process to Process

    // Pipe stdout of one process to stdin of another
    await $`cat file.txt`.pipe($`grep pattern`).pipe($`wc -l`);

    // Pipe stderr specifically
    await $`cmd`.pipe.stderr($`error-handler`);

### Process to File

    await $`generate-data`.pipe(fs.createWriteStream('output.txt'));

    // Or using path shorthand
    await $`generate-data`.pipe('/tmp/output.txt');

### Input from String/Buffer

    await $({ input: 'hello world' })`cat`;
    await $({ input: previousOutput })`process-stdin`;


## Directory & Context

    import { cd, within } from 'zx/core';

    // Global cd (affects ALL subsequent commands — use sparingly)
    cd('/tmp');
    await $`pwd`;  // /tmp

    // Scoped cd with within() — PREFERRED
    await within(async () => {
        cd('/tmp');
        await $`pwd`;  // /tmp
    });
    await $`pwd`;  // original directory

    // Or use cwd option — SIMPLEST
    await $({ cwd: '/tmp' })`pwd`;  // /tmp


## Utility Functions

### File & Path

    import { glob, fs, path, tmpdir, tmpfile, which } from 'zx/core';

    // Glob — returns string[]
    const tsFiles = await glob('src/**/*.ts');
    const configs = await glob(['*.json', '*.yaml']);

    // fs — fs-extra (superset of Node fs with promises)
    await fs.readJson('package.json');
    await fs.copy('src', 'dist');
    await fs.ensureDir('output');
    await fs.pathExists('file.txt');
    await fs.outputFile('deep/nested/file.txt', 'content');

    // tmpdir / tmpfile — auto-cleaned on exit
    const dir = tmpdir('my-build');    // returns path
    const file = tmpfile('data.json', '{"key": "value"}');

    // which — find binary in PATH
    const nodePath = await which('node');

### Async Control

    import { sleep, retry, spinner } from 'zx/core';

    // Sleep
    await sleep(1000);  // ms

    // Retry with backoff
    const result = await retry(5, '1s', async () => {
        return await fetch('https://api.example.com/health');
    });

    // Spinner (auto-disabled in CI)
    await spinner('Building...', async () => {
        await $`npm run build`;
    });

### User Interaction

    import { question, stdin, echo, argv } from 'zx/core';

    // Prompt user
    const name = await question('Your name: ');
    const choice = await question('Pick one: ', { choices: ['a', 'b', 'c'] });

    // Read stdin
    const input = await stdin();

    // Echo (like console.log but handles ProcessOutput)
    echo`Build complete: ${result}`;

    // CLI arguments (pre-parsed by minimist)
    // script.mjs --name=foo --verbose -n 5
    argv.name;     // 'foo'
    argv.verbose;  // true
    argv.n;        // 5
    argv._;        // positional args

### Process Management

    import { ps, kill } from 'zx/core';

    const procs = await ps.lookup({ command: 'node' });
    const tree = await ps.tree({ pid: process.pid, recursive: true });
    await kill(pid, 'SIGTERM');

### Data Formats

    import { YAML } from 'zx/core';

    const data = YAML.parse(await fs.readFile('config.yaml', 'utf8'));
    const yamlStr = YAML.stringify(data);

### Network

    import { fetch } from 'zx/core';

    const res = await fetch('https://api.example.com/data');
    const data = await res.json();

### Shell Quoting

    import { quote, quotePowerShell } from 'zx/core';

    // Manual quoting (rarely needed — $ does this automatically)
    const quoted = quote('string with spaces');

### Terminal Colors

    import { chalk } from 'zx/core';

    console.log(chalk.green('Success'));
    console.log(chalk.red.bold('Error'));
    console.log(chalk.yellow('Warning'));
    console.log(chalk.dim('Secondary info'));
    console.log(chalk.cyan.underline('Link'));


## Global Defaults

    // Set defaults for all commands
    $.verbose = false;       // don't print commands
    $.quiet = true;          // suppress output
    $.shell = '/bin/bash';   // default shell
    $.prefix = 'set -e;';   // fail-fast in shell
    $.env = { ...process.env, NODE_ENV: 'production' };

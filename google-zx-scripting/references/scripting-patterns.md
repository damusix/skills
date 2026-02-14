# Scripting Patterns


Patterns for ad-hoc scripts, CLI tools, build systems, deployment, and project automation.

## Script Boilerplate

Every zx script should follow this structure:

    #!/usr/bin/env npx zx

    import { $, argv, chalk, fs, path, glob, within } from 'zx/core';

    // ── Config ──────────────────────────────────────
    $.verbose = false;

    // ── Main ────────────────────────────────────────
    async function main() {
        // script logic here
    }

    main().catch((err) => {
        console.error(chalk.red(err.message));
        process.exit(1);
    });


## Ad-Hoc One-Liners & Quick Scripts

### Run a Command and Use Its Output

    const branch = (await $`git branch --show-current`).text().trim();
    console.log(`On branch: ${branch}`);

### Check If a Command Exists

    import { which } from 'zx/core';

    const docker = await which('docker', { nothrow: true });
    if (!docker) {
        console.log(chalk.red('Docker is not installed'));
        process.exit(1);
    }

### Run Commands Conditionally

    const status = await $`git status --porcelain`;
    if (status.stdout.trim()) {
        await $`git add -A && git commit -m "auto-save"`;
    } else {
        echo('Working tree clean');
    }

### Quick Find and Replace Across Files

    const files = await glob('src/**/*.ts');
    for (const file of files) {
        let content = await fs.readFile(file, 'utf8');
        if (content.includes('oldImport')) {
            content = content.replaceAll('oldImport', 'newImport');
            await fs.writeFile(file, content);
            echo(chalk.green(`Updated ${file}`));
        }
    }


## CLI Tool Pattern

    #!/usr/bin/env npx zx

    import { $, argv, chalk, question } from 'zx/core';

    $.verbose = false;

    const help = `
    Usage: ./tool.mjs <command> [options]

    Commands:
        init        Initialize project
        build       Build project
        deploy      Deploy to environment

    Options:
        --env       Target environment (default: staging)
        --dry-run   Show what would happen without executing
        --help      Show this help
    `;

    if (argv.help || argv._.length === 0) {
        echo(help);
        process.exit(0);
    }

    const [command] = argv._;
    const env = argv.env || 'staging';
    const dryRun = argv['dry-run'] || false;

    const commands = {
        async init() {
            echo(chalk.cyan('Initializing project...'));
            await $`npm install`;
            await $`cp .env.example .env`;
            echo(chalk.green('Done!'));
        },
        async build() {
            await $`npm run build`;
        },
        async deploy() {
            if (dryRun) {
                echo(chalk.yellow(`Would deploy to ${env}`));
                return;
            }
            const confirm = await question(`Deploy to ${env}? (y/N) `);
            if (confirm.toLowerCase() !== 'y') return;
            await $`./deploy.sh ${env}`;
        },
    };

    if (!commands[command]) {
        echo(chalk.red(`Unknown command: ${command}`));
        process.exit(1);
    }

    await commands[command]();


## Build Scripts

### Basic Build Pipeline

    #!/usr/bin/env npx zx

    import { $, chalk, fs, spinner } from 'zx/core';

    $.verbose = false;

    echo(chalk.cyan('Building project...'));

    // Clean
    await fs.remove('dist');
    await fs.ensureDir('dist');

    // Type check + build in parallel
    await spinner('Compiling...', () =>
        Promise.all([
            $`npx tsc --noEmit`,
            $`npx esbuild src/index.ts --bundle --outdir=dist --platform=node`,
        ])
    );

    // Copy assets
    await fs.copy('public', 'dist/public');

    const size = (await $`du -sh dist`).text().trim();
    echo(chalk.green(`Build complete (${size})`));

### Multi-Package Monorepo Build

    #!/usr/bin/env npx zx

    import { $, chalk, fs, glob, within } from 'zx/core';

    $.verbose = false;

    const packages = await glob('packages/*/package.json');
    const sorted = await topologicalSort(packages); // your dependency sort

    for (const pkg of sorted) {
        const dir = path.dirname(pkg);
        const name = (await fs.readJson(pkg)).name;
        echo(chalk.cyan(`Building ${name}...`));
        await within(async () => {
            cd(dir);
            await $`npm run build`;
        });
    }

    echo(chalk.green('All packages built'));

### Docker Build Script

    #!/usr/bin/env npx zx

    import { $, argv, chalk } from 'zx/core';

    $.verbose = false;

    const tag = argv.tag || 'latest';
    const registry = argv.registry || 'ghcr.io/myorg';
    const image = `${registry}/myapp:${tag}`;

    echo(chalk.cyan(`Building ${image}...`));
    await $`docker build -t ${image} .`;

    if (argv.push) {
        echo(chalk.cyan('Pushing...'));
        await $`docker push ${image}`;
    }

    echo(chalk.green(`Image: ${image}`));


## Deployment Scripts

### SSH Deploy

    #!/usr/bin/env npx zx

    import { $, argv, chalk, question } from 'zx/core';

    $.verbose = false;

    const envConfig = {
        staging: { host: 'staging.example.com', path: '/app' },
        production: { host: 'prod.example.com', path: '/app' },
    };

    const env = argv.env || 'staging';
    const { host, path: remotePath } = envConfig[env];

    if (env === 'production') {
        const answer = await question(chalk.yellow('Deploy to PRODUCTION? (type "yes"): '));
        if (answer !== 'yes') process.exit(0);
    }

    echo(chalk.cyan(`Deploying to ${env}...`));
    await $`rsync -avz --delete dist/ ${host}:${remotePath}/`;
    await $`ssh ${host} "cd ${remotePath} && npm install --production && pm2 restart app"`;
    echo(chalk.green(`Deployed to ${env}`));

### Database Migration Runner

    #!/usr/bin/env npx zx

    import { $, chalk, fs, glob } from 'zx/core';

    $.verbose = false;

    const applied = new Set(
        (await $`psql -t -c "SELECT name FROM migrations"`).lines().map(l => l.trim()).filter(Boolean)
    );

    const migrations = (await glob('migrations/*.sql')).sort();
    const pending = migrations.filter(m => !applied.has(path.basename(m)));

    if (pending.length === 0) {
        echo(chalk.green('No pending migrations'));
        process.exit(0);
    }

    for (const migration of pending) {
        const name = path.basename(migration);
        echo(chalk.cyan(`Applying ${name}...`));
        await $`psql -f ${migration}`;
        await $`psql -c ${`INSERT INTO migrations (name) VALUES ('${name}')`}`;
    }

    echo(chalk.green(`Applied ${pending.length} migration(s)`));


## Project Scaffolding

    #!/usr/bin/env npx zx

    import { $, argv, chalk, fs, question } from 'zx/core';

    $.verbose = false;

    const name = argv._[0] || await question('Project name: ');
    const dir = path.resolve(name);

    await fs.ensureDir(dir);
    await fs.ensureDir(`${dir}/src`);
    await fs.ensureDir(`${dir}/tests`);

    await fs.writeJson(`${dir}/package.json`, {
        name,
        version: '0.0.0',
        type: 'module',
        scripts: {
            build: 'tsc',
            test: 'node --test tests/',
        },
    }, { spaces: 4 });

    await fs.writeFile(`${dir}/src/index.ts`, 'export {};\n');
    await fs.writeFile(`${dir}/tsconfig.json`, JSON.stringify({
        compilerOptions: {
            target: 'ES2022', module: 'NodeNext', outDir: 'dist',
            strict: true, declaration: true,
        },
        include: ['src'],
    }, null, 4));

    echo(chalk.green(`Created ${name}/`));
    echo(chalk.dim(`  cd ${name} && npm install`));


## Git Automation

### Release Script

    #!/usr/bin/env npx zx

    import { $, argv, chalk, question } from 'zx/core';

    $.verbose = false;

    // Ensure clean tree
    const status = (await $`git status --porcelain`).text().trim();
    if (status) {
        echo(chalk.red('Working tree is dirty. Commit or stash changes first.'));
        process.exit(1);
    }

    const pkg = await fs.readJson('package.json');
    const bump = argv.bump || 'patch';
    echo(chalk.cyan(`Bumping ${bump}: ${pkg.version} -> ...`));

    await $`npm version ${bump} --no-git-tag-version`;
    const newPkg = await fs.readJson('package.json');

    await $`git add package.json`;
    await $`git commit -m ${'release: v' + newPkg.version}`;
    await $`git tag ${'v' + newPkg.version}`;

    echo(chalk.green(`Tagged v${newPkg.version}`));
    echo(chalk.dim('Run: git push --follow-tags'));

### Branch Cleanup

    #!/usr/bin/env npx zx

    import { $, chalk } from 'zx/core';

    $.verbose = false;

    const merged = (await $`git branch --merged main`)
        .lines()
        .map(b => b.trim())
        .filter(b => b && b !== 'main' && !b.startsWith('*'));

    if (merged.length === 0) {
        echo(chalk.green('No merged branches to clean'));
        process.exit(0);
    }

    echo(chalk.yellow(`Deleting ${merged.length} merged branches:`));
    for (const branch of merged) {
        echo(chalk.dim(`  ${branch}`));
        await $`git branch -d ${branch}`;
    }


## Environment & Prerequisites Check

    #!/usr/bin/env npx zx

    import { $, chalk, which } from 'zx/core';

    $.verbose = false;

    const requirements = ['node', 'docker', 'git', 'psql'];
    let ok = true;

    for (const cmd of requirements) {
        const found = await which(cmd, { nothrow: true });
        if (found) {
            echo(chalk.green(`✓ ${cmd}`));
        } else {
            echo(chalk.red(`✗ ${cmd} — not found`));
            ok = false;
        }
    }

    // Version checks
    const nodeVersion = (await $`node -v`).text().trim();
    const major = parseInt(nodeVersion.slice(1));
    if (major < 18) {
        echo(chalk.red(`Node ${nodeVersion} too old, need >= 18`));
        ok = false;
    }

    if (!ok) process.exit(1);
    echo(chalk.green('\nAll prerequisites met'));


## Error Handling Patterns

### Graceful Failure with Fallback

    // Try preferred tool, fall back to alternative
    const formatter = await which('prettier', { nothrow: true })
        ? 'prettier --write'
        : 'npx eslint --fix';
    await $`${formatter} src/`;

### Nothrow for Expected Failures

    // grep returns exit 1 when no match — not an error
    const result = await $({ nothrow: true })`grep -r "TODO" src/`;
    if (result.exitCode === 0) {
        echo(chalk.yellow(`TODOs found:\n${result.stdout}`));
    }

### Retry Flaky Operations

    import { retry } from 'zx/core';

    await retry(3, '2s', async () => {
        await $`npm publish`;
    });

### Timeout Long Commands

    const result = await $`npm test`.timeout('5m', 'SIGKILL');


## Parallel Execution

    import { within } from 'zx/core';

    // Run independent tasks in parallel with isolated contexts
    await Promise.all([
        within(async () => {
            cd('packages/core');
            await $`npm test`;
        }),
        within(async () => {
            cd('packages/cli');
            await $`npm test`;
        }),
        within(async () => {
            cd('packages/utils');
            await $`npm test`;
        }),
    ]);

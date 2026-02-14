# Processing Recipes


Patterns for file processing, data pipelines, batch operations, AI scripts, log analysis, and ETL tasks.

## File Processing

### Read, Transform, Write

    #!/usr/bin/env npx zx

    import { $, chalk, fs, glob } from 'zx/core';

    $.verbose = false;

    const files = await glob('data/**/*.json');
    let processed = 0;

    for (const file of files) {
        const data = await fs.readJson(file);
        const transformed = transformData(data); // your logic
        await fs.writeJson(file, transformed, { spaces: 4 });
        processed++;
    }

    echo(chalk.green(`Processed ${processed} files`));

### Batch Rename Files

    #!/usr/bin/env npx zx

    import { chalk, fs, glob, path } from 'zx/core';

    $.verbose = false;

    const files = await glob('images/*.PNG');
    for (const file of files) {
        const newName = path.join(
            path.dirname(file),
            path.basename(file, '.PNG').toLowerCase() + '.png'
        );
        await fs.move(file, newName);
        echo(chalk.dim(`${path.basename(file)} -> ${path.basename(newName)}`));
    }

### Find Duplicates by Content Hash

    #!/usr/bin/env npx zx

    import { $, chalk, glob } from 'zx/core';

    $.verbose = false;

    const files = await glob('**/*.{jpg,png,gif}');
    const hashMap = {};

    for (const file of files) {
        const hash = (await $`md5 -q ${file}`).text().trim();
        (hashMap[hash] ||= []).push(file);
    }

    const dupes = Object.values(hashMap).filter(g => g.length > 1);
    for (const group of dupes) {
        echo(chalk.yellow('Duplicates:'));
        group.forEach(f => echo(chalk.dim(`  ${f}`)));
    }

    echo(chalk.green(`Found ${dupes.length} duplicate groups`));

### Convert File Formats in Bulk

    #!/usr/bin/env npx zx

    import { $, chalk, fs, glob, path, spinner, within } from 'zx/core';

    $.verbose = false;

    const files = await glob('docs/**/*.md');
    await fs.ensureDir('output/html');

    await spinner(`Converting ${files.length} files...`, async () => {
        // Process in batches of 10
        for (let i = 0; i < files.length; i += 10) {
            const batch = files.slice(i, i + 10);
            await Promise.all(batch.map(async (file) => {
                const out = path.join('output/html', path.basename(file, '.md') + '.html');
                await $`pandoc ${file} -o ${out}`;
            }));
        }
    });

    echo(chalk.green(`Converted ${files.length} files`));


## CSV & Data Processing

### CSV Pipeline

    #!/usr/bin/env npx zx

    import { $, chalk, fs } from 'zx/core';

    $.verbose = false;

    // Read CSV, process rows, write result
    const raw = await fs.readFile('input.csv', 'utf8');
    const [header, ...rows] = raw.trim().split('\n');
    const columns = header.split(',');

    const processed = rows
        .map(row => {
            const values = row.split(',');
            const obj = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
            // Transform
            obj.email = obj.email?.toLowerCase();
            obj.processed_at = new Date().toISOString();
            return obj;
        })
        .filter(row => row.email); // filter invalid

    // Write as JSON
    await fs.writeJson('output.json', processed, { spaces: 4 });
    echo(chalk.green(`Processed ${processed.length} rows`));

### JSON Lines (NDJSON) Stream Processing

    #!/usr/bin/env npx zx

    import { $, chalk, fs } from 'zx/core';

    $.verbose = false;

    const input = await fs.readFile('events.jsonl', 'utf8');
    const events = input.trim().split('\n').map(JSON.parse);

    const grouped = {};
    for (const event of events) {
        (grouped[event.type] ||= []).push(event);
    }

    for (const [type, items] of Object.entries(grouped)) {
        echo(chalk.cyan(`${type}: ${items.length} events`));
        await fs.writeJson(`output/${type}.json`, items, { spaces: 4 });
    }


## Log Analysis

### Parse and Summarize Logs

    #!/usr/bin/env npx zx

    import { $, chalk, fs, glob } from 'zx/core';

    $.verbose = false;

    const logs = await glob('/var/log/app/*.log');
    const errors = {};
    let totalLines = 0;

    for (const log of logs) {
        const content = await fs.readFile(log, 'utf8');
        const lines = content.split('\n');
        totalLines += lines.length;

        for (const line of lines) {
            if (line.includes('ERROR')) {
                const match = line.match(/ERROR\s+(\S+)/);
                const key = match?.[1] || 'unknown';
                errors[key] = (errors[key] || 0) + 1;
            }
        }
    }

    echo(chalk.cyan(`Scanned ${totalLines} lines across ${logs.length} files\n`));
    const sorted = Object.entries(errors).sort((a, b) => b[1] - a[1]);
    for (const [error, count] of sorted.slice(0, 20)) {
        echo(`  ${chalk.red(String(count).padStart(6))}  ${error}`);
    }

### Tail and Filter Live Logs

    #!/usr/bin/env npx zx

    import { $, chalk } from 'zx/core';

    const filter = argv._[0] || 'ERROR';

    for await (const line of $`tail -f /var/log/app/current.log`) {
        if (line.includes(filter)) {
            const colored = line.includes('ERROR') ? chalk.red(line)
                : line.includes('WARN') ? chalk.yellow(line)
                : chalk.dim(line);
            echo(colored);
        }
    }


## API & Network Processing

### Batch API Calls with Rate Limiting

    #!/usr/bin/env npx zx

    import { chalk, fetch, fs, sleep } from 'zx/core';

    $.verbose = false;

    const ids = await fs.readJson('user-ids.json');
    const results = [];
    const BATCH_SIZE = 5;
    const DELAY_MS = 1000;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
            batch.map(async (id) => {
                const res = await fetch(`https://api.example.com/users/${id}`);
                return res.json();
            })
        );
        results.push(...batchResults);
        echo(chalk.dim(`  ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length}`));
        if (i + BATCH_SIZE < ids.length) await sleep(DELAY_MS);
    }

    await fs.writeJson('users.json', results, { spaces: 4 });
    echo(chalk.green(`Fetched ${results.length} users`));

### Download Files in Parallel

    #!/usr/bin/env npx zx

    import { $, chalk, fs, path } from 'zx/core';

    $.verbose = false;

    const urls = (await fs.readFile('urls.txt', 'utf8')).trim().split('\n');
    await fs.ensureDir('downloads');

    const CONCURRENCY = 5;
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
        const batch = urls.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (url) => {
            const name = path.basename(new URL(url).pathname);
            await $`curl -sL -o ${'downloads/' + name} ${url}`;
        }));
        echo(chalk.dim(`  ${Math.min(i + CONCURRENCY, urls.length)}/${urls.length}`));
    }


## AI Script Patterns

### LLM API Call Script

    #!/usr/bin/env npx zx

    import { chalk, fetch, fs } from 'zx/core';

    $.verbose = false;

    const prompt = argv._[0] || await stdin();
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
        echo(chalk.red('Set OPENAI_API_KEY or ANTHROPIC_API_KEY'));
        process.exit(1);
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    const data = await res.json();
    echo(data.choices[0].message.content);

### Batch Process Files with AI

    #!/usr/bin/env npx zx

    import { chalk, fetch, fs, glob, sleep } from 'zx/core';

    $.verbose = false;

    const files = await glob('docs/**/*.md');
    const summaries = [];

    for (const file of files) {
        const content = await fs.readFile(file, 'utf8');
        echo(chalk.dim(`Summarizing ${file}...`));

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{
                    role: 'user',
                    content: `Summarize this document in 2-3 sentences:\n\n${content.slice(0, 4000)}`,
                }],
            }),
        });

        const data = await res.json();
        summaries.push({
            file,
            summary: data.choices[0].message.content,
        });

        await sleep(500); // rate limit
    }

    await fs.writeJson('summaries.json', summaries, { spaces: 4 });
    echo(chalk.green(`Generated ${summaries.length} summaries`));

### Code Generation Script

    #!/usr/bin/env npx zx

    import { chalk, fetch, fs } from 'zx/core';

    $.verbose = false;

    const schema = await fs.readFile(argv.schema || 'schema.sql', 'utf8');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-5-20250514',
            max_tokens: 4096,
            messages: [{
                role: 'user',
                content: `Generate TypeScript interfaces from this SQL schema:\n\n${schema}`,
            }],
        }),
    });

    const data = await res.json();
    const code = data.content[0].text;
    await fs.outputFile('src/types/schema.ts', code);
    echo(chalk.green('Generated src/types/schema.ts'));


## Image & Media Processing

    #!/usr/bin/env npx zx

    import { $, chalk, fs, glob, path, within } from 'zx/core';

    $.verbose = false;

    const images = await glob('photos/**/*.{jpg,jpeg,png}');
    await fs.ensureDir('optimized');

    const CONCURRENCY = 4;
    for (let i = 0; i < images.length; i += CONCURRENCY) {
        const batch = images.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (img) => {
            const out = path.join('optimized', path.basename(img));
            await $`convert ${img} -resize 1200x1200\\> -quality 85 ${out}`;
        }));
        echo(chalk.dim(`  ${Math.min(i + CONCURRENCY, images.length)}/${images.length}`));
    }

    echo(chalk.green(`Optimized ${images.length} images`));


## ETL (Extract, Transform, Load)

    #!/usr/bin/env npx zx

    import { $, chalk, fs, YAML } from 'zx/core';

    $.verbose = false;

    // Extract
    echo(chalk.cyan('Extracting...'));
    const dbDump = (await $`psql -t -A -c "SELECT row_to_json(t) FROM users t"`).lines().filter(Boolean);
    const users = dbDump.map(JSON.parse);

    // Transform
    echo(chalk.cyan('Transforming...'));
    const transformed = users.map(u => ({
        id: u.id,
        name: `${u.first_name} ${u.last_name}`,
        email: u.email.toLowerCase(),
        active: u.status === 'active',
    }));

    // Load
    echo(chalk.cyan('Loading...'));
    await fs.writeJson('export/users.json', transformed, { spaces: 4 });
    await fs.writeFile('export/users.yaml', YAML.stringify(transformed));
    await fs.writeFile('export/users.csv',
        ['id,name,email,active',
         ...transformed.map(u => `${u.id},${u.name},${u.email},${u.active}`)
        ].join('\n')
    );

    echo(chalk.green(`Exported ${transformed.length} users to JSON, YAML, and CSV`));


## Watch & React

### File Watcher Script

    #!/usr/bin/env npx zx

    import { $, chalk } from 'zx/core';

    echo(chalk.cyan('Watching src/ for changes...'));

    // Using fswatch (macOS) or inotifywait (Linux)
    for await (const line of $`fswatch -r src/`) {
        const file = line.trim();
        echo(chalk.dim(`Changed: ${file}`));
        try {
            await $({ quiet: true })`npm run build`;
            echo(chalk.green('Build OK'));
        } catch (e) {
            echo(chalk.red(`Build failed: ${e.stderr}`));
        }
    }


## Workspace & Cleanup Scripts

### Project Cleanup

    #!/usr/bin/env npx zx

    import { $, chalk, fs, glob } from 'zx/core';

    $.verbose = false;

    const targets = [
        'node_modules', 'dist', 'build', '.cache',
        'coverage', '.turbo', '.next',
    ];

    let freed = 0;
    for (const target of targets) {
        const dirs = await glob(`**/${target}`, { onlyDirectories: true });
        for (const dir of dirs) {
            const size = (await $({ nothrow: true })`du -sh ${dir}`).text().split('\t')[0];
            echo(chalk.dim(`  rm ${dir} (${size})`));
            await fs.remove(dir);
            freed++;
        }
    }

    echo(chalk.green(`Cleaned ${freed} directories`));

### Dependency Audit

    #!/usr/bin/env npx zx

    import { $, chalk, fs } from 'zx/core';

    $.verbose = false;

    const pkg = await fs.readJson('package.json');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    echo(chalk.cyan('Checking for outdated packages...\n'));

    const outdated = await $({ nothrow: true })`npm outdated --json`;
    if (outdated.exitCode === 0) {
        echo(chalk.green('All packages up to date'));
    } else {
        const data = JSON.parse(outdated.stdout);
        for (const [name, info] of Object.entries(data)) {
            echo(`  ${chalk.yellow(name)}: ${info.current} -> ${chalk.green(info.latest)}`);
        }
    }

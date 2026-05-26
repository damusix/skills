# CLI Reference


## Commands

### sg run

One-off pattern search and rewrite from the command line.

    sg run --pattern 'PATTERN' [--rewrite 'REPLACEMENT'] [OPTIONS] [PATHS...]

**Required (one of):**

| Flag | Description |
|------|-------------|
| `-p, --pattern <PATTERN>` | Code pattern to match |
| `-k, --kind <KIND>` | AST node kind to match |

**Matching options:**

| Flag | Description |
|------|-------------|
| `--selector <KIND>` | Extract a sub-node from the pattern match |
| `-l, --lang <LANG>` | Target language (auto-inferred from file extension if omitted) |
| `--strictness <MODE>` | cst, smart (default), ast, relaxed, signature |
| `--debug-query[=<FORMAT>]` | Show the parsed AST of the pattern |

**Rewrite options:**

| Flag | Description |
|------|-------------|
| `-r, --rewrite <TEXT>` | Replacement string (supports metavariables) |
| `-i, --interactive` | Approve each rewrite individually |
| `-U, --update-all` | Apply all rewrites without confirmation |

**Output options:**

| Flag | Description |
|------|-------------|
| `--json[=<STYLE>]` | JSON output: `pretty`, `stream`, `compact` |
| `-A <N>` | Lines of context after match |
| `-B <N>` | Lines of context before match |
| `-C <N>` | Lines of context before and after |
| `--color <WHEN>` | `auto`, `always`, `ansi`, `never` |
| `--heading <WHEN>` | Show file headings |

**Filtering options:**

| Flag | Description |
|------|-------------|
| `--globs <PATTERNS>` | Include/exclude file patterns |
| `--no-ignore <SCOPE>` | Override ignore files: hidden, dot, exclude, global, parent, vcs |
| `--follow` | Follow symlinks |
| `--stdin` | Read from stdin |

**Performance:**

| Flag | Description |
|------|-------------|
| `-j, --threads <N>` | Thread count |
| `--inspect <LEVEL>` | nothing, summary, entity |


### sg scan

Scan a project using YAML rule files.

    sg scan [OPTIONS] [PATHS...]

**Rule sources (pick one or more):**

| Flag | Description |
|------|-------------|
| `-c, --config <FILE>` | Path to sgconfig.yml (default: `sgconfig.yml`) |
| `-r, --rule <FILE>` | Single rule file |
| `--inline-rules <YAML>` | Rule defined inline as a YAML string |
| `--filter <REGEX>` | Filter rules by ID pattern |

**Severity overrides:**

| Flag | Description |
|------|-------------|
| `--error[=<IDS>...]` | Override severity to error |
| `--warning[=<IDS>...]` | Override severity to warning |
| `--info[=<IDS>...]` | Override severity to info |
| `--hint[=<IDS>...]` | Override severity to hint |
| `--off[=<IDS>...]` | Disable specific rules |

**Output options:**

| Flag | Description |
|------|-------------|
| `--json[=<STYLE>]` | JSON output: `pretty`, `stream`, `compact` |
| `--format <FMT>` | Report format: `github` (annotations), `sarif` |
| `--report-style <STYLE>` | Display style: `rich`, `medium`, `short` |
| `--include-metadata` | Include rule metadata in JSON output |

Supports the same interactive (`-i`), update-all (`-U`), filtering, and performance flags as `sg run`.


### sg test

Validate rules against test cases.

    sg test [OPTIONS]

| Flag | Description |
|------|-------------|
| `-c, --config <FILE>` | Path to sgconfig.yml |
| `-t, --test-dir <DIR>` | Test directory |
| `--snapshot-dir <DIR>` | Snapshot directory (default: `__snapshots__`) |
| `-f, --filter` | Filter tests by glob |
| `--skip-snapshot-tests` | Validate syntax only |
| `--include-off` | Include disabled rules |
| `-U, --update-all` | Update all snapshots |
| `-i, --interactive` | Approve snapshot changes one by one |


### sg new

Scaffold new rules, tests, and projects.

    sg new [COMMAND] [OPTIONS] [NAME]

Subcommands: `project`, `rule`, `test`, `util`

| Flag | Description |
|------|-------------|
| `-l, --lang <LANG>` | Target language |
| `-y, --yes` | Accept defaults (non-interactive) |
| `-b, --base-dir <DIR>` | Output directory |


### sg lsp

Start the language server for editor integration.

    sg lsp [-c, --config <FILE>]


### sg completions

Generate shell completions.

    sg completions [bash|elvish|fish|powershell|zsh]


## Common Patterns

Search for a pattern:

    sg run -p 'console.log($ARG)' -l javascript

Search and replace:

    sg run -p 'require($MOD)' -r 'import $MOD from $MOD' -l javascript -U

Scan with a single rule file:

    sg scan --rule rules/no-eval.yml

Scan with inline rule:

    sg scan --inline-rules 'id: test, language: js, rule: {pattern: "eval($$$)"}'

JSON output for scripting:

    sg run -p 'TODO' --json=compact

Debug pattern parsing:

    sg run -p '$FUNC($$$)' --debug-query -l typescript


## Sources

[^cli-ref]: ast-grep docs — CLI Reference (all commands overview). <https://ast-grep.github.io/reference/cli.html>
[^cli-run]: ast-grep docs — `ast-grep run` command reference. <https://ast-grep.github.io/reference/cli/run.html>
[^cli-scan]: ast-grep docs — `ast-grep scan` command reference. <https://ast-grep.github.io/reference/cli/scan.html>
[^cli-test]: ast-grep docs — `ast-grep test` command reference. <https://ast-grep.github.io/reference/cli/test.html>
[^cli-new]: ast-grep docs — `ast-grep new` command reference. <https://ast-grep.github.io/reference/cli/new.html>
[^json-mode]: ast-grep docs — JSON Mode (structured output for scripting). <https://ast-grep.github.io/guide/tools/json.html>

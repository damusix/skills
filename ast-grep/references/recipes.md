# Recipes


## Search Patterns

### Find all function calls to a specific function

    sg run -p 'fetch($$$ARGS)' -l javascript

### Find unused imports (no reference in file)

Requires a YAML rule -- pattern-only search cannot express "not used elsewhere":

```yaml
id: unused-import
language: TypeScript
rule:
  pattern: import { $NAME } from '$MOD'
  not:
    has:
      pattern: $NAME
      stopBy: end
```

### Find `console.*` calls

    sg run -p 'console.$METHOD($$$)' -l javascript

### Find deeply nested awaits in loops

```yaml
id: no-await-in-loop
language: TypeScript
rule:
  pattern: await $EXPR
  inside:
    any:
      - kind: for_statement
      - kind: for_in_statement
      - kind: while_statement
      - kind: do_statement
    stopBy: end
```

### Find assignments where both sides are identical

    sg run -p '$A = $A' -l javascript


## Lint Rules

### Ban `eval()`

```yaml
id: no-eval
language: JavaScript
severity: error
message: "eval() is a security risk. Use alternatives."
rule:
  pattern: eval($$$)
```

### Require `===` over `==`

```yaml
id: eqeqeq
language: JavaScript
severity: warning
message: "Use === instead of =="
rule:
  pattern: $A == $B
  not:
    any:
      - pattern: $A == null
      - pattern: null == $A
fix: $A === $B
```

### Flag `any` type annotations in TypeScript

```yaml
id: no-explicit-any
language: TypeScript
severity: warning
message: "Avoid explicit 'any'. Use 'unknown' with type guards."
rule:
  kind: predefined_type
  regex: ^any$
  not:
    inside:
      kind: type_assertion
      stopBy: neighbor
```


## Rewrites / Codemods

### Rename a function across the codebase

    sg run -p 'oldFunction($$$ARGS)' -r 'newFunction($$$ARGS)' -l typescript -U

### Convert `require` to `import`

```yaml
id: require-to-import
language: JavaScript
rule:
  pattern: const $NAME = require('$MOD')
fix: import $NAME from '$MOD'
```

### Swap function arguments

```yaml
id: swap-args
language: TypeScript
rule:
  pattern: assertEqual($ACTUAL, $EXPECTED)
fix: assertEqual($EXPECTED, $ACTUAL)
```

### Remove a deprecated function call (delete the statement)

```yaml
id: remove-deprecated
language: TypeScript
rule:
  pattern: deprecatedSetup($$$)
fix: ''
```

### Convert string concatenation to template literal

```yaml
id: prefer-template-literal
language: TypeScript
rule:
  pattern: $A + $B
  all:
    - pattern: $A + $B
    - has:
        kind: string
fix: "`${$A}${$B}`"
```

### Add a wrapper around an expression

```yaml
id: wrap-with-memo
language: TypeScript
rule:
  pattern: useCallback($$$ARGS)
  not:
    inside:
      pattern: useMemo($$$)
      stopBy: neighbor
fix: useMemo(() => useCallback($$$ARGS), [])
```


## Transform Examples

### Convert variable name from camelCase to snake_case in fix

```yaml
id: rename-convention
language: Python
rule:
  pattern: 'def $FUNC_NAME($$$): $$$'
transform:
  SNAKE_NAME:
    convert:
      source: $FUNC_NAME
      toCase: snakeCase
fix: 'def $SNAKE_NAME($$$): $$$'
```

### Extract substring (strip quotes)

```yaml
transform:
  UNQUOTED:
    substring:
      source: $STRING_LIT
      startChar: 1
      endChar: -1
```

### Regex replace within a captured value

```yaml
transform:
  CLEANED:
    replace:
      source: $TEXT
      replace: '_v\d+'
      by: ''
```


## Project Setup

### Initialize a new ast-grep project

    sg new project

Creates `sgconfig.yml` with default `ruleDirs` and `testConfigs`.

### Create a new rule

    sg new rule -l typescript

Scaffolds a rule YAML file in the configured `ruleDirs`.

### Create a test for a rule

    sg new test

Scaffolds a test YAML file in the configured test directory.


## Testing

### Run all tests (skip snapshots)

    sg test --skip-snapshot-tests

### Update snapshots

    sg test -U

### Test a single rule

    sg test --filter 'no-eval'


## Debugging

### Inspect AST structure with --debug-query

When a pattern doesn't match, inspect the actual AST to find correct node kinds:

    sg run --pattern 'async function example() { await fetch(); }' \
      --lang javascript --debug-query=cst

Formats:

- `cst` -- full concrete syntax tree (all nodes including punctuation)
- `ast` -- abstract syntax tree (named nodes only)
- `pattern` -- how ast-grep interprets your pattern's metavariables

### Quick iteration with stdin

Test rules against code snippets without creating files:

    echo "const x = await fetch();" | sg scan --inline-rules 'id: test
    language: javascript
    rule:
      pattern: "await $EXPR"' --stdin

Add `--json` for structured output.

### Shell escaping for inline rules

The shell interprets `$` as a variable. Two approaches:

    # Escape each metavariable
    sg scan --inline-rules "rule: {pattern: 'console.log(\$ARG)'}" .

    # Or wrap the whole thing in single quotes
    sg scan --inline-rules 'rule: {pattern: "console.log($ARG)"}' .

### Debugging checklist when rules don't match

1. Simplify -- remove sub-rules until something matches
2. Add `stopBy: end` to every relational rule (`inside`, `has`, `follows`, `precedes`)
3. Use `--debug-query=cst` to verify node kind names
4. Check that `regex` matches the ENTIRE node text, not a substring
5. Verify metavariable naming is uppercase: `$NAME` not `$name`


## Tips

- Use `--debug-query` to inspect how ast-grep parses your pattern. Node kind names differ between languages.
- Use `--json=stream` for piping into `jq` or other tools.
- Use `--globs '!**/*.test.ts'` to exclude test files from scans.
- Start with `sg run -p` for exploration, then graduate to YAML rules for repeatability.
- Combine `kind` + `regex` when `pattern` alone is too broad or too narrow.
- Use `utils` to DRY up repeated sub-patterns across `all`/`any` blocks.
- When fixing, test with `--interactive` first to preview changes before `--update-all`.


## Sources

[^quick-start]: ast-grep docs — Quick Start guide. <https://ast-grep.github.io/guide/quick-start.html>
[^rule-essentials]: ast-grep docs — Rule Essentials (intro to writing rules). <https://ast-grep.github.io/guide/rule-config.html>
[^scan-project]: ast-grep docs — Project Setup (sgconfig.yml, rule dirs). <https://ast-grep.github.io/guide/scan-project.html>
[^rewrite-code]: ast-grep docs — Rewrite Code (fix, metavariable substitution). <https://ast-grep.github.io/guide/rewrite-code.html>
[^catalog]: ast-grep docs — Rule Examples catalog (per-language rule examples). <https://ast-grep.github.io/catalog.html>
[^faq]: ast-grep docs — FAQ (common issues and solutions). <https://ast-grep.github.io/advanced/faq.html>
[^playground]: ast-grep — Interactive Playground (test patterns in browser). <https://ast-grep.github.io/playground.html>
[^languages]: ast-grep docs — Supported Languages list. <https://ast-grep.github.io/reference/languages.html>

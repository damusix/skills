# Recipes

<examples>

## Search Patterns

<example description="Find all function calls to a specific function">

    sg run -p 'fetch($$$ARGS)' -l javascript

</example>

<example description="Find unused imports (no reference in file)">

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

</example>

<example description="Find console.* calls">

    sg run -p 'console.$METHOD($$$)' -l javascript

</example>

<example description="Find deeply nested awaits in loops">

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

</example>

<example description="Find assignments where both sides are identical">

    sg run -p '$A = $A' -l javascript

</example>


## Lint Rules

<example description="Ban eval()">

```yaml
id: no-eval
language: JavaScript
severity: error
message: "eval() is a security risk. Use alternatives."
rule:
  pattern: eval($$$)
```

</example>

<example description="Require === over ==">

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

</example>

<example description="Flag any type annotations in TypeScript">

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

</example>


## Rewrites / Codemods

<example description="Rename a function across the codebase">

    sg run -p 'oldFunction($$$ARGS)' -r 'newFunction($$$ARGS)' -l typescript -U

</example>

<example description="Convert require to import">

```yaml
id: require-to-import
language: JavaScript
rule:
  pattern: const $NAME = require('$MOD')
fix: import $NAME from '$MOD'
```

</example>

<example description="Swap function arguments">

```yaml
id: swap-args
language: TypeScript
rule:
  pattern: assertEqual($ACTUAL, $EXPECTED)
fix: assertEqual($EXPECTED, $ACTUAL)
```

</example>

<example description="Remove a deprecated function call (delete the statement)">

```yaml
id: remove-deprecated
language: TypeScript
rule:
  pattern: deprecatedSetup($$$)
fix: ''
```

</example>

<example description="Convert string concatenation to template literal">

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

</example>

<example description="Add a wrapper around an expression">

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

</example>


## Transform Examples

<example description="Convert variable name from camelCase to snake_case in fix">

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

</example>

<example description="Extract substring (strip quotes)">

```yaml
transform:
  UNQUOTED:
    substring:
      source: $STRING_LIT
      startChar: 1
      endChar: -1
```

</example>

<example description="Regex replace within a captured value">

```yaml
transform:
  CLEANED:
    replace:
      source: $TEXT
      replace: '_v\d+'
      by: ''
```

</example>

</examples>


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

<workflow>

### Debugging workflow

1. **Reproduce** -- `sg scan -r rule.yml test.file` or paste into the [playground](https://ast-grep.github.io/playground.html)
2. **Reduce** -- strip the target code to the minimal snippet that should match
3. **Inspect** -- `sg run -p '{code}' -l {lang} --debug-query=cst` to see actual AST structure
4. **Simplify the rule** -- remove sub-rules one at a time until something matches, then add back incrementally

</workflow>

<constraints>

### Debugging checklist when rules don't match

1. Simplify -- remove sub-rules until something matches
2. Add `stopBy: end` to every relational rule (`inside`, `has`, `follows`, `precedes`)
3. Use `--debug-query=cst` to verify node kind names
4. Check that `regex` matches the ENTIRE node text, not a substring
5. Verify metavariable naming is uppercase: `$NAME` not `$name`
6. Check metavariable binding order -- when the same `$VAR` appears in multiple sub-rules of a rule object, the capture from the first-evaluated rule wins. If the wrong rule captures first, wrap in `all` to control order explicitly.
7. Check for nested node structures -- some AST structures are unintuitive. C/C++ `case_statement` nodes nest all subsequent cases as descendants, not siblings. Use `stopBy: { kind: case_statement }` to prevent search from penetrating into adjacent cases.

**AST structure frequently contradicts how source code looks visually.** Always verify with `--debug-query=cst` rather than assuming node relationships from indentation or code layout.

</constraints>


<examples>

## Advanced Techniques

<example description="Match by node kind + field name (Go test functions)">

Use `kind` + `has` with `field` to match structural positions without writing a full pattern:

```yaml
id: find-test-functions
language: Go
rule:
  kind: function_declaration
  has:
    field: name
    regex: ^Test
```

</example>

<example description="Match by field type (Java String fields)">

```yaml
id: find-string-fields
language: Java
rule:
  kind: field_declaration
  has:
    field: type
    regex: ^String$
```

</example>

<example description="context + selector for sub-expressions">

When matching fragments that aren't standalone-valid code, wrap in context:

```yaml
# C function call (not valid as a standalone statement without context)
id: match-c-call
language: C
rule:
  pattern:
    context: $M($$$);
    selector: call_expression
```

```yaml
# Go function call inside a function body
id: match-go-call
language: Go
rule:
  pattern:
    context: 'func t() { fmt.Println($$$A) }'
    selector: call_expression
```

</example>

<example description="Naming convention enforcement with constraints">

Use `constraints` + `regex` when matching requires name-based filtering. `$VAR` captures the full node; the constraint narrows:

```yaml
# React: flag functions named use* that don't call hooks
id: unnecessary-hook
language: TSX
utils:
  hook_call:
    has:
      kind: call_expression
      regex: ^use
      stopBy: end
rule:
  any:
    - pattern: function $FUNC($$$) { $$$ }
    - pattern: const $FUNC = ($$$) => $$$
  has:
    pattern: $BODY
    kind: statement_block
    stopBy: end
constraints:
  FUNC: { regex: ^use }
  BODY: { not: { matches: hook_call } }
```

</example>

<example description="Architectural boundary enforcement">

Restrict imports to enforce layered architecture:

```yaml
# Kotlin: flag domain layer importing data/presentation
id: clean-architecture
language: Kotlin
rule:
  pattern: import $PATH
constraints:
  PATH:
    any:
      - regex: com\.example(\.\w+)*\.data
      - regex: com\.example(\.\w+)*\.presentation
files:
  - '**/domain/**'
```

</example>

<example description="stopBy with a rule object (scoped search boundary)">

Stop relational search at a specific node kind rather than `end` or `neighbor`:

```yaml
# Flag await inside Promise.all array -- stop search at array/arguments boundary
id: no-await-in-promise-all
language: TypeScript
rule:
  pattern: await $A
  inside:
    pattern: Promise.all($_)
    stopBy:
      not:
        any:
          - kind: array
          - kind: arguments
fix: $A
```

</example>

<example description="Recursive rewriting with rewriters">

Rewriters apply recursively to transform nested structures. First match wins per node; higher AST levels match before deeper ones:

```yaml
# Python: recursively rewrite Optional[X] to X | None, including nested
id: modernize-optional
language: Python
rewriters:
  - id: optional
    rule:
      pattern:
        context: 'a: Optional[$TYPE]'
        selector: generic_type
    transform:
      NT:
        rewrite:
          rewriters: [optional]
          source: $TYPE
    fix: $NT | None
rule:
  pattern:
    context: 'a: Optional[$TYPE]'
    selector: generic_type
transform:
  NT:
    rewrite:
      rewriters: [optional]
      source: $TYPE
fix: $NT | None
```

</example>

<example description="Barrel import splitting with rewriters + joinBy">

Transform a single barrel import into per-module direct imports:

```yaml
id: split-barrel-import
language: TypeScript
rule:
  pattern: import {$$$IDENTS} from './barrel'
rewriters:
  - id: rewrite-identifier
    rule:
      pattern: $IDENT
      kind: identifier
    fix: import $IDENT from './barrel/$IDENT'
transform:
  IMPORTS:
    rewrite:
      rewriters: [rewrite-identifier]
      source: $$$IDENTS
      joinBy: "\n"
fix: $IMPORTS
```

</example>

<example description="Angular: lifecycle method without decorator">

Combine `inside` + `not` + `has` to detect a missing ancestor attribute:

```yaml
id: missing-component-decorator
language: TypeScript
rule:
  pattern:
    context: 'class Hi { $METHOD() { $$$ } }'
    selector: method_definition
  inside:
    pattern: 'class $KLASS $$$ { $$$ }'
    stopBy: end
    not:
      has:
        pattern: '@Component($$$)'
constraints:
  METHOD: { regex: ^ngOnInit|ngOnDestroy$ }
```

</example>

</examples>


<constraints>

## Tips

- Use `--debug-query` to inspect how ast-grep parses your pattern. Node kind names differ between languages.
- Use `--json=stream` for piping into `jq` or other tools.
- Use `--globs '!**/*.test.ts'` to exclude test files from scans.
- Start with `sg run -p` for exploration, then graduate to YAML rules for repeatability.
- Combine `kind` + `regex` when `pattern` alone is too broad or too narrow.
- Use `utils` to DRY up repeated sub-patterns across `all`/`any` blocks.
- When fixing, test with `--interactive` first to preview changes before `--update-all`.

</constraints>


## Sources

[^quick-start]: ast-grep docs — Quick Start guide. <https://ast-grep.github.io/guide/quick-start.html>
[^rule-essentials]: ast-grep docs — Rule Essentials (intro to writing rules). <https://ast-grep.github.io/guide/rule-config.html>
[^scan-project]: ast-grep docs — Project Setup (sgconfig.yml, rule dirs). <https://ast-grep.github.io/guide/scan-project.html>
[^rewrite-code]: ast-grep docs — Rewrite Code (fix, metavariable substitution). <https://ast-grep.github.io/guide/rewrite-code.html>
[^catalog]: ast-grep docs — Rule Examples catalog (per-language rule examples). <https://ast-grep.github.io/catalog.html>
[^faq]: ast-grep docs — FAQ (common issues and solutions). <https://ast-grep.github.io/advanced/faq.html>
[^playground]: ast-grep — Interactive Playground (test patterns in browser). <https://ast-grep.github.io/playground.html>
[^languages]: ast-grep docs — Supported Languages list. <https://ast-grep.github.io/reference/languages.html>

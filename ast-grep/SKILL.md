---
name: ast-grep
description: "AST-based code search, lint, and rewrite using ast-grep. Use when finding code patterns structurally (not textually), writing lint rules, building codemods, or migrating API usage across a codebase. Prefer over regex grep when the match target is a syntactic construct (function call, import, class field, assignment)."
---

# ast-grep

ast-grep (`sg`) is a CLI tool that searches, lints, and rewrites code using Abstract Syntax Trees instead of text patterns. It uses tree-sitter parsers, supports 20+ languages (including Markdown), and runs in seconds across large codebases.

Write a code snippet as a pattern, and ast-grep matches it structurally against the AST -- ignoring whitespace, comments, and formatting differences.

Patterns are one atomic building block. When a pattern alone can't express what you need (disambiguation, naming constraints, relational checks, transforms), graduate to a full YAML rule. Patterns handle ~60% of searches; YAML rules handle the rest.

<constraints>

1. **Write valid parseable code as patterns.** Tree-sitter must parse the pattern. Invalid syntax silently produces zero matches with no error, so always verify a new pattern returns results before adding constraints.
2. **Metavariable names use UPPERCASE:** `$NAME`, `$$$ARGS`, `$_`. Lowercase `$name` is treated as literal code, not a capture.
3. **`$X` captures exactly one AST node.** Use `$$$X` for zero-or-more. The mismatch is the most common cause of "pattern doesn't match" -- a single-arg pattern won't match a two-arg call.
4. **Same name = same content:** `$A == $A` matches `x == x` but rejects `x == y`. This is structural equality, not variable binding -- use it intentionally.
5. **Every rule needs at least one positive atomic rule** (`pattern`, `kind`, or `regex`). A `not` rule alone is invalid because ast-grep needs something to anchor the search.
6. **`regex` matches the full node text.** Partial matches fail. `/foo/` does not match `fooBar` -- use `^foo` if you want prefix matching.
7. **`fix` replaces the single matched node.** It cannot patch multiple locations. Use `expandStart`/`expandEnd` to consume surrounding tokens (trailing commas, semicolons).
8. **Unmatched metavariables become empty strings in `fix`.** This is intentional for optional captures, but verify your pattern actually captures what you expect before relying on it in a rewrite.
9. **Use `stopBy: end` on relational rules** (`inside`, `has`, `follows`, `precedes`) unless you specifically want neighbor-only matching. The default `stopBy: neighbor` stops at the first non-matching node and misses deeper results -- this is the second most common cause of "rule doesn't match."
10. **Shell escaping for `--inline-rules`:** the shell interprets `$` as a variable. Wrap YAML in single quotes or escape each metavariable with `\$VAR`.
11. **Write example code before writing rules.** Small mistakes in rule composition cascade into completely invalid output. Write a concrete code snippet that should match, verify the AST structure with `--debug-query=cst`, then build the rule against that snippet.
12. **Verify every rule before searching the codebase.** Test against the example snippet with `sg scan --inline-rules '...' --stdin` or `sg scan -r rule.yml test.file`. This catches composition errors before they waste a full codebase scan.

</constraints>

<workflow>

Rules are compositions of atomic parts. A single error in one part cascades, so verify at each step.

1. **Understand the intent** -- what code pattern are you looking for? What should match and what should not?
2. **Write example code** -- a concrete snippet that should match the rule, and one that should not. These are the test fixtures.
3. **Explore the AST** -- `sg run --pattern 'TARGET_CODE' --debug-query=cst -l LANG` to see node kinds and structure of the example code.
4. **Write the rule** -- start with the simplest possible pattern. Add constraints, relational rules, and transforms incrementally. Test after each addition.
5. **Test the rule against the example** -- `echo "example code" | sg scan --inline-rules '...' --stdin` or `sg scan -r rule.yml example.file`. Confirm it matches the positive case and rejects the negative case.
6. **Search the codebase** -- `sg scan` for the full project. Review a sample of results to confirm precision.
7. **Formalize** -- if reusable, add `id`, `message`, `severity`, `fix`. Write test YAML with `sg new test`, generate snapshots with `sg test -U`.

When a rule doesn't work, go back to step 3. The AST structure frequently contradicts how source code looks visually -- verify with `--debug-query=cst` rather than assuming.

Before reporting a rule as done, run it against both the positive and negative example. Confirm it matches what it should and rejects what it shouldn't.

</workflow>

<examples>

<example description="Search: find all calls to a function">

    sg run -p 'fetch($$$ARGS)' -l javascript

</example>

<example description="Search: find a pattern with naming constraints">

```yaml
rule:
  pattern: $HOOK($$$ARGS)
constraints:
  HOOK: { regex: '^use' }
```

</example>

<example description="Rewrite: rename across the codebase">

    sg run -p 'oldFunction($$$ARGS)' -r 'newFunction($$$ARGS)' -l typescript -U

</example>

<example description="Rule: match sub-expressions that aren't standalone-valid code">

Use `context` + `selector` when the target fragment needs surrounding syntax to parse:

```yaml
rule:
  pattern:
    context: 'class A { a = 123 }'
    selector: field_definition
```

</example>

<example description="Rule: find await inside loops with relational rules">

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
    stopBy: end
```

</example>

</examples>

## References

- [Pattern Syntax](references/pattern-syntax.md) -- Metavariables, matching rules, strictness modes, pattern object for disambiguation
- [Rule Reference](references/rule-reference.md) -- Atomic, relational, and composite rules, matching order, ESQuery selectors
- [YAML Configuration](references/yaml-config.md) -- Full rule file schema: fix, transform, constraints, utils, rewriters
- [CLI Reference](references/cli.md) -- All commands, flags, output formats, CLI vs Playground differences
- [Recipes](references/recipes.md) -- Search, lint, rewrite, transform, debugging, and advanced technique examples

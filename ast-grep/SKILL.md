---
name: ast-grep
description: "AST-based code search, lint, and rewrite using ast-grep. Use when finding code patterns structurally (not textually), writing lint rules, building codemods, or migrating API usage across a codebase. Prefer over regex grep when the match target is a syntactic construct (function call, import, class field, assignment)."
---

# ast-grep


## What It Is

ast-grep (`sg`) is a CLI tool that searches, lints, and rewrites code using Abstract Syntax Trees instead of text patterns. It uses tree-sitter parsers, supports 20+ languages, and runs in seconds across large codebases.

Core idea: write a code snippet as a pattern, and ast-grep matches it structurally against the AST — ignoring whitespace, comments, and formatting differences.


## Quick Start

Search for a pattern:

    sg run --pattern 'console.log($ARG)' --lang javascript

Rewrite matches:

    sg run --pattern 'console.log($ARG)' --rewrite 'logger.info($ARG)' -U

Scan with a YAML rule file:

    sg scan --rule no-console.yml

Test your rules:

    sg test


## Critical Rules

1. **Pattern code must be valid parseable code** -- tree-sitter must parse it. Invalid syntax silently fails.
2. **Metavariable names are UPPERCASE** -- `$NAME`, `$$$ARGS`, `$_`. Lowercase `$name` is invalid.
3. **`$X` matches exactly one AST node** -- use `$$$X` for zero-or-more nodes.
4. **Same metavariable name = same content** -- `$A == $A` matches `x == x` but not `x == y`.
5. **Rules require at least one positive atomic rule** -- `not` alone is invalid; combine with `pattern`, `kind`, or `regex`.
6. **`regex` matches the entire node text** -- partial matches fail. Use `^` and `$` anchors explicitly if needed.
7. **`fix` replaces the single matched node** -- it cannot patch multiple locations. Use `expandStart`/`expandEnd` for surrounding tokens (commas, brackets).
8. **Unmatched metavariables become empty strings in fix** -- intentional, but verify your patterns capture what you expect.
9. **Always use `stopBy: end` on relational rules** (`inside`, `has`, `follows`, `precedes`) unless you specifically want neighbor-only matching. Without it, the search stops at the first non-matching node and misses deeper results.
10. **Shell escaping for `--inline-rules`** -- the shell interprets `$` as a variable. Use `\$VAR` in double-quoted strings or wrap the YAML in single quotes.


## Workflow

1. **Explore the AST** -- `sg run --pattern 'TARGET_CODE' --debug-query=cst -l LANG` to see node kinds and structure
2. **Test against stdin** -- `echo "code" | sg scan --inline-rules '...' --stdin` for rapid iteration without files
3. **Write pattern** -- start simple, add constraints incrementally
4. **Test interactively** -- `sg run -p 'PATTERN' --interactive` to preview matches on real files
5. **Formalize as YAML rule** -- add `id`, `message`, `severity`, `fix`
6. **Write tests** -- `sg new test`, add valid/invalid cases, generate snapshots with `sg test -U`
7. **Run scan** -- `sg scan` for the full project


## References

- [Pattern Syntax](references/pattern-syntax.md) -- Metavariables, matching rules, strictness modes
- [Rule Reference](references/rule-reference.md) -- Atomic, relational, and composite rules
- [YAML Configuration](references/yaml-config.md) -- Full rule file schema: fix, transform, constraints, utils, rewriters
- [CLI Reference](references/cli.md) -- All commands, flags, output formats
- [Recipes](references/recipes.md) -- Common patterns for search, lint, and rewrite tasks

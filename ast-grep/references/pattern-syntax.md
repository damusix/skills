# Pattern Syntax

A pattern is a code snippet that ast-grep parses into an AST and matches structurally against target code. The pattern `a + 1` matches anywhere `a + 1` appears as an expression node, regardless of nesting depth:

    const b = a + 1        // matched
    funcCall(a + 1)         // matched
    { target: a + 1 }       // matched

Patterns search the full syntax tree, not just top-level statements.


## Metavariables

Metavariables are wildcard placeholders in patterns. They capture AST nodes during matching.

### Single-node: `$NAME`

Matches exactly one AST node. Named with `$` + uppercase letters, underscores, digits.

Valid: `$META`, `$META_VAR`, `$META_VAR1`, `$_`, `$_123`
Invalid: `$invalid`, `$Svalue`, `$123`, `$KEBAB-CASE`, `$`

<example description="Single-node metavariable matching">

`console.log($GREETING)` matches:

    console.log('Hello World')     // $GREETING = 'Hello World'
    console.log(getMsg())          // $GREETING = getMsg()

Does NOT match:

    console.log()                  // missing argument
    console.log(a, b)              // two arguments, $GREETING expects one

</example>

### Multi-node: `$$$NAME`

Matches zero or more AST nodes. Use for variable-length argument lists, statement sequences.

<example description="Multi-node metavariable matching">

`console.log($$$ARGS)` matches:

    console.log()                       // $$$ARGS = []
    console.log('hello')                // $$$ARGS = ['hello']
    console.log('debug:', key, value)   // $$$ARGS = ['debug:', key, value]

`function $FUNC($$$PARAMS) { $$$BODY }` captures function name, all parameters, and all body statements.

</example>

<constraints>

**Lazy matching:** `$$$` stops capturing when the next element in the pattern matches. `foo($$$A, b, $$$C)` against `foo(a, c, b, b, c)` captures only `a, c` in `$$$A` -- it stops at the first `b`. This ensures linear-time matching but means `$$$` between identical separators can produce unexpected splits.

</constraints>

### Non-capturing: `$_NAME`

Underscore prefix suppresses capture. Each `$_X` can match different content independently.

`$_FUNC($_ARG)` matches any single-argument function call -- `$_FUNC` and `$_ARG` are not linked:

    test(a)           // matched
    foo(1 + 1)        // matched

### Unnamed node capture: `$$NAME`

Double-dollar captures anonymous (unnamed) tree-sitter nodes. Single `$NAME` only captures named nodes.

### Same-name constraint

Repeating a metavariable name enforces identical content:

    $A == $A     matches: x == x, (1+1) == (1+1)
                 rejects: x == y, 1 == 2


## Pattern as Object

When a pattern string is ambiguous (could parse as expression or statement), use the object form:

```yaml
rule:
  pattern:
    context: 'class C { $FIELD = $INIT }'
    selector: field_definition
```

- `context` -- surrounding code that disambiguates the parse
- `selector` -- tree-sitter node kind to extract from the parsed result

<constraints>

**When to use this:** if your pattern is a sub-expression that isn't valid standalone code, it will silently fail to parse. Example: `"key": "$VAL"` fails as standalone JSON. Wrap it: `context: '{"key": "$VAL"}'`, `selector: pair`. Always use `context` + `selector` for class fields, object properties, decorator arguments, and other fragments that need surrounding syntax to parse.

</constraints>


## Strictness Modes

Control how precisely the pattern must match the AST:

| Mode | Description |
|------|-------------|
| `cst` | Exact CST match including trivia |
| `smart` | Default. Matches structurally, ignores trivia |
| `ast` | Ignores named/unnamed node distinction |
| `relaxed` | Loosest: ignores more structural differences |
| `signature` | Matches function signatures ignoring body |

Set via CLI `--strictness` flag or YAML `pattern.strictness` field.


<constraints>

## Limitations

- Patterns do not match inside comments or string literals.
- Pattern code must be parseable by tree-sitter for the target language.
- Each `$X` matches exactly one node; use `$$$X` for sequences.
- Metavariable names appended with uppercase letters can be ambiguous: `$VARName` parses as `$VARN` + `ame`. Use `transform` instead for concatenation.
- **No prefix/suffix mixing:** `use$HOOK` and `io_uring_$FUNC` are invalid -- a metavariable must represent a complete AST node. For prefix matching, use `constraints` with `regex`:

```yaml
rule:
  pattern: $HOOK($$$ARGS)
constraints:
  HOOK: { regex: '^use' }
```

- **No scope, type, or flow analysis:** ast-grep operates on syntax trees only. It cannot find unused variables, identify types, detect unreachable code, or trace data flow. See [tool comparison](https://ast-grep.github.io/advanced/tool-comparison.html) for tools that can.

</constraints>


## Sources

[^pattern-syntax]: ast-grep docs — Pattern Syntax. <https://ast-grep.github.io/guide/pattern-syntax.html>
[^core-concepts]: ast-grep docs — Core Concepts (AST, named vs unnamed nodes). <https://ast-grep.github.io/advanced/core-concepts.html>
[^pattern-parse]: ast-grep docs — How Pattern Syntax Works (internal parsing, ambiguity). <https://ast-grep.github.io/advanced/pattern-parse.html>
[^match-algorithm]: ast-grep docs — Pattern Match Algorithm (strictness modes, matching semantics). <https://ast-grep.github.io/advanced/match-algorithm.html>

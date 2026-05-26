# Rule Reference


## Rule Object

A rule object defines how to match AST nodes. It combines atomic, relational, and composite sub-rules. A node must satisfy ALL fields in the rule object to match.

Every rule must contain at least one positive atomic rule (`pattern`, `kind`, or `regex`). A `not` rule alone is invalid.


<constraints>

## Matching Order

Rule objects are unordered dictionaries -- ast-grep applies them in implementation-defined order: atomic rules first, then composite rules, then relational rules. The first rule that references a metavariable **captures** it; later rules can only match against that captured value.

**Use `all` for order-dependent matching.** When a metavariable must be captured by one rule before another rule references it, wrap them in `all` to enforce explicit sequencing.

</constraints>

<example description="Enforcing metavariable capture order with all">

Finding recursive functions requires capturing `$F` from the declaration before searching for calls:

```yaml
rule:
  all:
  - pattern: function $F() { $$$ }
  - has:
      pattern: $F()
      stopBy: end
```

Reversing the order fails because `has` would capture `$F` as the first call it finds, not the declaration.

</example>


## Atomic Rules

### pattern

Matches nodes against a code pattern with metavariables.

<example description="pattern rule -- string form">

```yaml
rule:
  pattern: console.log($ARG)
```

</example>

<example description="pattern rule -- object form for disambiguation">

```yaml
rule:
  pattern:
    context: 'class C { $FIELD = $INIT }'
    selector: field_definition
    strictness: smart
```

</example>

### kind

Matches nodes by their tree-sitter node kind name.

```yaml
rule:
  kind: call_expression
```

Supports ESQuery-style selectors (v0.39+) for structural relationships:

```yaml
rule:
  kind: 'call_expression > identifier'
```

Selector syntax: `A > B` (child), `A B` (descendant), `A + B` (adjacent sibling), `A ~ B` (general sibling), `A, B` (union), `:is(A, B)`, `:has()`, `:not()`, `:nth-child()`. Also works with `sg run --kind`:

    sg run -k 'program > export_statement' -l ts

Use `sg run --pattern '$X' --debug-query` to discover node kind names.

<constraints>

**`kind` and `pattern` are independent rules.** Combining them in a rule object does NOT make tree-sitter parse the pattern string as the specified kind. `{ pattern: 'a = 123', kind: field_definition }` will not match class fields -- `a = 123` still parses as an assignment expression. Use the pattern object form instead: `pattern: { context: 'class A { a = 123 }', selector: field_definition }`.

</constraints>

### regex

Matches the entire text of a node against a Rust-flavored regex. Must match the full text, not a substring.

```yaml
rule:
  regex: ^console\.\w+$
```

Cannot stand alone -- must combine with `pattern` or `kind`. Lacks lookaround and backreferences.

### nthChild

Matches nodes by their position among siblings (1-based index, named nodes only).

<examples>

<example description="nthChild -- number form">

```yaml
rule:
  nthChild: 1
```

</example>

<example description="nthChild -- CSS An+B form">

```yaml
rule:
  nthChild: '2n+1'
```

</example>

<example description="nthChild -- object form with ofRule filter">

```yaml
rule:
  nthChild:
    position: 2
    reverse: true
    ofRule:
      kind: function_declaration
```

</example>

</examples>


### range

Matches nodes at specific source positions. 0-based, character-indexed. Start is inclusive, end is exclusive.

```yaml
rule:
  range:
    start: { line: 0, column: 0 }
    end: { line: 0, column: 3 }
```


## Relational Rules

Filter nodes based on their position relative to other nodes in the AST.

### inside

Node must appear within an ancestor matching the sub-rule.

```yaml
rule:
  pattern: await $EXPR
  inside:
    kind: for_statement
    stopBy: end
```

### has

Node must contain a descendant matching the sub-rule.

```yaml
rule:
  kind: function_declaration
  has:
    pattern: return $VAL
    stopBy: end
```

### follows

Node must appear after a sibling matching the sub-rule.

```yaml
rule:
  pattern: $X
  follows:
    pattern: import $MOD
```

### precedes

Node must appear before a sibling matching the sub-rule.

```yaml
rule:
  pattern: $X
  precedes:
    pattern: export default $EXPR
```

### stopBy (sub-field)

Controls how far relational rules search. Available on all relational rules.

| Value | Behavior |
|-------|----------|
| `neighbor` | Default. Stop at the immediate parent/child/sibling. |
| `end` | Search all the way to root (inside), all descendants (has), or all siblings (follows/precedes). |
| Rule object | Stop when a node matches this rule (inclusive boundary). |

<constraints>

**Nested AST gotcha:** some tree-sitter node kinds nest unintuitively. C/C++ `case_statement` nodes contain all subsequent cases as descendants, not siblings. When searching with `has` or `inside`, use `stopBy: { kind: case_statement }` (or the relevant boundary kind) to prevent matching through to unrelated nested nodes. Always verify structure with `--debug-query=cst`.

</constraints>

### field (sub-field)

Available on `inside` and `has` only. Restricts matching to a specific named field of the parent node.

```yaml
rule:
  kind: identifier
  inside:
    kind: assignment_expression
    field: left
```


## Composite Rules

### all

ALL sub-rules must match the same node:

```yaml
rule:
  all:
    - pattern: $FUNC($$$ARGS)
    - not:
        inside:
          kind: test_block
          stopBy: end
```

Metavariables from all sub-rules are merged.

### any

At least one sub-rule must match:

```yaml
rule:
  any:
    - pattern: console.log($$$)
    - pattern: console.warn($$$)
    - pattern: console.error($$$)
```

Only metavariables from the matching sub-rule are available.

### not

Negates a single sub-rule:

```yaml
rule:
  pattern: $FUNC($$$)
  not:
    pattern: console.log($$$)
```

### matches

References a utility rule by name (defined in `utils` or global `utilDirs`):

```yaml
utils:
  is-console-call:
    any:
      - pattern: console.log($$$)
      - pattern: console.warn($$$)
rule:
  matches: is-console-call
  not:
    inside:
      kind: catch_clause
      stopBy: end
```


## Sources

[^rule-object]: ast-grep docs — Rule Object reference (all fields, constraints, semantics). <https://ast-grep.github.io/reference/rule.html>
[^atomic-rule]: ast-grep docs — Atomic Rule (pattern, kind, regex, nthChild). <https://ast-grep.github.io/guide/rule-config/atomic-rule.html>
[^relational-rule]: ast-grep docs — Relational Rule (inside, has, follows, precedes, stopBy, field). <https://ast-grep.github.io/guide/rule-config/relational-rule.html>
[^composite-rule]: ast-grep docs — Composite Rule (all, any, not, matches). <https://ast-grep.github.io/guide/rule-config/composite-rule.html>
[^utility-rule]: ast-grep docs — Utility Rule (reusable named rules via matches). <https://ast-grep.github.io/guide/rule-config/utility-rule.html>
[^esquery]: ast-grep docs — ESQuery Style Kind selector syntax. <https://ast-grep.github.io/reference/rule/esquery.html>

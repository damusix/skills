# Rule Reference


## Rule Object

A rule object defines how to match AST nodes. It combines atomic, relational, and composite sub-rules. A node must satisfy ALL fields in the rule object to match.

Every rule must contain at least one positive atomic rule (`pattern`, `kind`, or `regex`). A `not` rule alone is invalid.


## Atomic Rules

### pattern

Matches nodes against a code pattern with metavariables.

String form:

```yaml
rule:
  pattern: console.log($ARG)
```

Object form (for disambiguation):

```yaml
rule:
  pattern:
    context: 'class C { $FIELD = $INIT }'
    selector: field_definition
    strictness: smart
```

### kind

Matches nodes by their tree-sitter node kind name.

```yaml
rule:
  kind: call_expression
```

Supports ESQuery-style selectors (v0.39+):

```yaml
rule:
  kind: 'call_expression > identifier'
```

Use `sg run --pattern '$X' --debug-query` to discover node kind names.

### regex

Matches the entire text of a node against a Rust-flavored regex. Must match the full text, not a substring.

```yaml
rule:
  regex: ^console\.\w+$
```

Cannot stand alone -- must combine with `pattern` or `kind`. Lacks lookaround and backreferences.

### nthChild

Matches nodes by their position among siblings (1-based index, named nodes only).

Number form:

```yaml
rule:
  nthChild: 1
```

CSS An+B form:

```yaml
rule:
  nthChild: '2n+1'
```

Object form:

```yaml
rule:
  nthChild:
    position: 2
    reverse: true
    ofRule:
      kind: function_declaration
```


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

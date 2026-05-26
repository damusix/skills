# YAML Configuration


## Rule File Schema

A YAML rule file defines a single lint rule or codemod. Top-level fields:


### Required Fields

**`id`** (String) -- Unique rule identifier. Example: `no-console-log`.

**`language`** (String) -- Target language for parsing. Values: Bash, C, Cpp, CSharp, Css, Elixir, Go, Haskell, Hcl, Html, Java, JavaScript, Json, Kotlin, Lua, Nix, Php, Python, Ruby, Rust, Scala, Solidity, Swift, Tsx, TypeScript, Yaml.

**`rule`** (Rule object) -- The matching rule. See [Rule Reference](rule-reference.md).


### Fix / Patching

**`fix`** (String or FixConfig) -- Replacement text for matched nodes. Metavariables from the pattern are substituted. Empty string deletes the match.

String form:

```yaml
fix: logger.info($ARG)
```

Object form (for surrounding token cleanup):

```yaml
fix:
  template: ''
  expandEnd:
    regex: ','
  expandStart:
    regex: ','
```

- `template` -- replacement text
- `expandStart` -- rule to expand the replacement range backward (e.g., to eat a preceding comma)
- `expandEnd` -- rule to expand the replacement range forward

**`rewriters`** (Array) -- Named rewriter sub-rules for use with the `rewrite` transform. Each entry has `id`, `rule`, and optionally `fix`/`transform`.


### Constraints

**`constraints`** (HashMap<String, Rule>) -- Filters on single metavariables (not `$$$` multi-vars). Applied after the main rule narrows results.

```yaml
constraints:
  ARG:
    not:
      kind: string_fragment
```

**`utils`** (HashMap<String, Rule>) -- Local utility rules referenced via `matches` in the main rule.


### Transform

**`transform`** (HashMap<String, Transformation>) -- Manipulate metavariable values before substitution in `fix`.

#### replace

Regex substitution on a metavariable's text:

```yaml
transform:
  NEW_NAME:
    replace:
      source: $OLD_NAME
      replace: 'Foo'
      by: 'Bar'
```

String shorthand: `replace($OLD_NAME, replace=Foo, by=Bar)`

#### substring

Extract a substring by character index (Unicode). Negative indices count from end.

```yaml
transform:
  TRIMMED:
    substring:
      source: $VAR
      startChar: 1
      endChar: -1
```

String shorthand: `substring($VAR, startChar=1, endChar=-1)`

#### convert

Change string casing:

```yaml
transform:
  SNAKE:
    convert:
      source: $NAME
      toCase: snakeCase
      separatedBy: [caseChange, underscore]
```

Cases: `lowerCase`, `upperCase`, `capitalize`, `camelCase`, `snakeCase`, `kebabCase`, `pascalCase`.

Separators: `dash`, `dot`, `space`, `slash`, `underscore`, `caseChange`.

String shorthand: `convert($NAME, toCase=snakeCase)`

#### rewrite

Apply rewriter rules to a metavariable's AST subtree:

```yaml
transform:
  REWRITTEN:
    rewrite:
      source: $$$ITEMS
      rewriters: [my-rewriter]
      joinBy: "\n"
```

String shorthand: `rewrite($$$ITEMS, rewriters=[my-rewriter], joinBy='\n')`

Rewriters apply in order; first match wins per node. Higher AST levels match before deeper ones.


### Linting Metadata

**`severity`** (String) -- `hint`, `info`, `warning`, `error`, `off`. Setting `off` disables the rule.

**`message`** (String) -- Single-line diagnostic. Can reference metavariables: `"Avoid using $FUNC directly"`.

**`note`** (String) -- Additional detail in markdown. Cannot reference metavariables.

**`url`** (String) -- Documentation link shown in editor extensions.

**`labels`** (HashMap) -- Customize highlighting for metavariables:

```yaml
labels:
  ARG:
    style: secondary
    message: "this argument"
```

**`metadata`** (HashMap<String, String>) -- Arbitrary key-value data for external tools (CVE IDs, OWASP categories). Exported with `--json --include-metadata`.


### File Scoping

**`files`** (Array<Glob>) -- Include only matching file paths (relative to project root, no `./` prefix).

**`ignores`** (Array<Glob>) -- Exclude matching file paths. Evaluated before `files`.


## sgconfig.yml

Project-level configuration file (like `tsconfig.json` for ast-grep).

```yaml
ruleDirs:
  - rules
  - custom-rules

testConfigs:
  - testDir: rule-tests
    snapshotDir: __snapshots__

utilDirs:
  - shared-utils

languageGlobs:
  html: ['*.vue', '*.svelte']
  json: ['.eslintrc']
```

### Fields

**`ruleDirs`** (required, Array<String>) -- Directories containing YAML rule files. Paths relative to sgconfig.yml.

**`testConfigs`** (optional, Array) -- Test directories. Each entry has `testDir` (required) and `snapshotDir` (optional, defaults to `__snapshots__` under testDir).

**`utilDirs`** (optional, Array<String>) -- Directories containing global utility rules.

**`languageGlobs`** (optional, HashMap) -- Map non-standard file extensions to language parsers.

**`customLanguages`** (optional, HashMap) -- Register custom tree-sitter parsers:

```yaml
customLanguages:
  myLang:
    libraryPath: ./parsers/my-lang.so
    extensions: ['.ml']
    expandoChar: '%'
```

**`languageInjections`** (experimental) -- Embedded language support (e.g., JS inside HTML).


## Test Files

Test YAML structure:

```yaml
id: rule-id-matching-the-rule-file
valid:
  - 'code that should NOT trigger the rule'
  - 'another valid case'
invalid:
  - 'code that SHOULD trigger the rule'
  - 'another invalid case'
```

Run tests:

    sg test --skip-snapshot-tests    # syntax validation only
    sg test -U                       # generate/update snapshots
    sg test --interactive            # approve snapshots interactively

Snapshots land in `__snapshots__/` and capture expected diagnostic output.


## Sources

[^yaml-config]: ast-grep docs — Rule Config YAML reference (all top-level fields). <https://ast-grep.github.io/reference/yaml.html>
[^fix]: ast-grep docs — Fix configuration (template, expandStart, expandEnd). <https://ast-grep.github.io/reference/yaml/fix.html>
[^transformation]: ast-grep docs — Transformation reference (replace, substring, convert, rewrite). <https://ast-grep.github.io/reference/yaml/transformation.html>
[^rewriter]: ast-grep docs — Rewriter rule reference. <https://ast-grep.github.io/reference/yaml/rewriter.html>
[^sgconfig]: ast-grep docs — Project Config (sgconfig.yml fields). <https://ast-grep.github.io/reference/sgconfig.html>
[^lint-rule]: ast-grep docs — Lint Rule guide (severity, message, note, labels). <https://ast-grep.github.io/guide/project/lint-rule.html>
[^test-rule]: ast-grep docs — Test Your Rule (test YAML structure, snapshots). <https://ast-grep.github.io/guide/test-rule.html>
[^rewrite-guide]: ast-grep docs — Rewrite Code guide (fix field, metavariable substitution, indentation). <https://ast-grep.github.io/guide/rewrite-code.html>
[^transform-guide]: ast-grep docs — Transform Code guide (practical transform examples). <https://ast-grep.github.io/guide/rewrite/transform.html>

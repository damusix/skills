# File Format

A Hurl file (`.hurl`, UTF-8, optional BOM tolerated) is a list of **entries**. Each entry is one mandatory **request** plus one optional **response** spec. Grammar: `hurl-file: entry* lt*`, `entry: request response?`. Verified against hurl.dev for Hurl 8.0.1.

Entries execute sequentially, top to bottom, in a shared context: captures from earlier entries are available as variables in later ones, and cookies accumulate in a shared per-run cookie jar (disable with `--no-cookie-store`). A file of bare requests with no response specs is valid — a response spec exists to assert response properties and/or capture values.


## File anatomy

There is no entry delimiter. A new entry starts at the next method line; everything after a response status line until the next METHOD line belongs to that response.

### Comments

`#` starts a comment to end of line, on its own line or trailing after content:

    # A very simple Hurl file
    GET https://www.sample.net
    x-app: MY_APP  # Add a dummy header
    HTTP 302       # Check that we have a redirection
    [Asserts]
    header "Location" contains "login"

A literal `#` inside a value must be escaped as `\#` so it is not parsed as a comment start:

    GET https://example.org/api
    x-token: BEEF \#STEAK # Some comment
    HTTP 200

### Whitespace

`sp` is space or tab; a line terminator is `sp* comment? [\n]?`. Blank lines between entries and between elements are insignificant.

### String escapes

`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, and Unicode scalars `\u{n}` (1–8 hex digits):

    GET https://example.org/api
    HTTP 200
    [Asserts]
    jsonpath "$.slideshow.title" == "A beautiful \u{2708}!"


## Request spec

Structure, in fixed order:

1. **Method + URL line** (mandatory): `METHOD sp URL`. Method grammar is `[A-Z]+` — any uppercase token works (GET, POST, PUT, DELETE, PATCH, custom verbs). The URL may include inline query params.
2. **Headers** (optional): `key: value` lines **immediately after the URL line, with no section name**. A `key: value` line right after the URL is a header; the same line inside `[Query]` is a query param — misplacing one silently changes meaning.
3. **Request sections** (optional): unordered, can be mixed in any way. Sections come after headers; headers can never appear after a section.
4. **Body** (optional): must be the last element of the request.

### Section names — current vs legacy

The grammar accepts both spellings; current docs use the short names — prefer them in new files, recognize both when reading:

| Current name | Legacy alias | Purpose |
|---|---|---|
| `[Query]` | `[QueryStringParams]` | query params, URL-encoded by Hurl; combined with inline URL params |
| `[Form]` | `[FormParams]` | `application/x-www-form-urlencoded` body |
| `[Multipart]` | `[MultipartFormData]` | `multipart/form-data` body, supports file fields |
| `[Cookies]` | — | per-request cookies |
| `[BasicAuth]` | — | basic auth user/password |
| `[Options]` | — | per-request runner options |

Each section body is `key: value` lines.

### [Query]

Values are written raw — Hurl URL-encodes them. Inline URL params and `[Query]` params combine:

    GET https://example.org/news
    [Query]
    order: newest
    search: something to search
    count: 100

Equivalent inline form: `GET https://example.org/news?order=newest&search=something%20to%20search&count=100`.

### [Form]

`[Form]` *is* the body (`application/x-www-form-urlencoded`) — mutually exclusive with an explicit body:

    POST https://example.org/contact
    [Form]
    default: false
    token: {{token}}
    email: john.doe@rookie.org

### [Multipart]

Plain fields and file fields. File field syntax is `name: file,filename;` with an optional content type after the `;`. Files resolve relative to the Hurl file's directory (subject to `--file-root`):

    POST https://example.org/upload
    [Multipart]
    field1: value1
    field2: file,example.txt;
    field3: file,example.zip; application/zip

For exotic cases, build the multipart body by hand as a multiline string with an explicit boundary in a `Content-Type` header:

    POST https://example.org/upload
    Content-Type: multipart/form-data; boundary="boundary"
    ```
    --boundary
    Content-Disposition: form-data; name="key1"

    value1
    --boundary--
    ```

### [Cookies]

    GET https://example.org/index.html
    [Cookies]
    theme: light
    sessionToken: abc123

### [BasicAuth]

Plain `user: password` — Hurl does the base64 encoding:

    GET https://example.org/protected
    [BasicAuth]
    bob: secret

### [Options]

Per-entry runner settings, overriding command-line flags for that entry. Documented options: `aws-sigv4`, `cacert`, `cert`, `key`, `compressed`, `connect-timeout`, `delay`, `http3`, `insecure`, `ipv6`, `limit-rate`, `location`, `location-trusted`, `max-redirs`, `max-time`, `output`, `path-as-is`, `proxy`, `repeat`, `resolve`, `retry`, `retry-interval`, `skip`, `unix-socket`, `user`, `variable`, `verbose`, `very-verbose`.

Notable behaviors:

- `variable: name=value` defines a variable for that entry **and all subsequent entries** (forward leak is by design).
- Control flow: `skip: true` bypasses the entry; `repeat: N` re-runs it; `delay: 5s` waits before sending.
- `retry: N` (-1 = unlimited) plus `retry-interval: 500ms` re-runs the entry on assert failures, capture errors, or runtime errors — this is the polling primitive:

      GET https://api.example.org/jobs/{{job_id}}
      [Options]
      retry: 10
      retry-interval: 500ms
      HTTP 200
      [Asserts]
      jsonpath "$.state" == "COMPLETED"

### Body types

Body is the last element of the request. Grammar: `bytes: json-value | xml | multiline-string | oneline-string | oneline-base64 | oneline-file | oneline-hex`.

**JSON** — bare, no fences; sets `Content-Type: application/json` automatically:

    POST https://example.org/api/dogs
    {
        "id": 0,
        "name": "Frieda"
    }

**XML** — bare, starting with `<?xml` or a tag (pair with an explicit `Content-Type` when needed):

    POST https://example.org/InStock
    Content-Type: application/soap+xml; charset=utf-8
    <?xml version="1.0" encoding="UTF-8"?>
    <soap:Envelope>...</soap:Envelope>

**Multiline string** — triple backticks, optional type tag. Grammar: `multiline-string-type: base64 | hex | json | xml | graphql | raw`. `graphql` changes request semantics (see below); the others mostly tag content:

    POST https://example.org/models
    ```
    Year,Make,Model
    1997,Ford,E350
    ```

**GraphQL** — a `graphql`-tagged multiline string; Hurl wraps the query into the standard `{"query": ..., "variables": ...}` JSON envelope and posts it. A `variables` block can follow the query inside the fence:

    POST https://example.org/starwars/graphql
    ```graphql
    query Hero($episode: Episode, $withFriends: Boolean!) {
      hero(episode: $episode) {
        name
      }
    }

    variables {
      "episode": "JEDI",
      "withFriends": false
    }
    ```

**Oneline string** — single backticks:

    POST https://example.org/hello
    `Hello world!`

**Base64 / hex / file** — one-liners with a mandatory trailing semicolon:

    POST https://example.org
    base64,TG9yZW0gaXBzdW0=;

    PUT https://example.org
    hex,636166c3a90a;

    POST https://example.org/api/tests
    Content-Type: application/json
    file,data.json;


## Response spec

Structure, in fixed order (grammar: `response: lt* version sp status lt* header* response-section* body?`):

### Version + status line

Mandatory if a response spec is present. Version grammar: `HTTP/1.0 | HTTP/1.1 | HTTP/2 | HTTP`. Bare `HTTP` matches any protocol version; a versioned form like `HTTP/2 200` *asserts* the protocol. `HTTP/3` is accepted by current Hurl even though the grammar page still lists only 1.0/1.1/2.

Status grammar is `[0-9]+`, but `HTTP *` (wildcard status) is shown throughout the official samples — use it when you only want explicit `status` asserts:

    GET https://example.org/order/435
    HTTP *
    [Asserts]
    status >= 200
    status < 300

### Headers — implicit asserts

Optional `key: value` lines after the status line are implicit equality asserts on response headers. Repeating a header name asserts multiple values:

    GET https://example.org/index.html
    HTTP 200
    Set-Cookie: theme=light
    Set-Cookie: sessionToken=abc123; Expires=Wed, 09 Jun 2021 10:18:14 GMT

### [Captures]

Extract values into variables for later entries. Grammar: `capture: lt* key-string : query (sp filter)* (sp redact)? lt*`. The optional trailing `redact` keyword marks the captured value as a secret, redacted from logs and reports:

    [Captures]
    csrf_token: xpath "string(//meta[@name='_csrf_token']/@content)"
    token: header "X-Token" redact

### [Asserts]

Explicit assertions. Grammar: `assert: lt* query (sp filter)* sp predicate lt*`. `[Captures]` and `[Asserts]` may appear in either order, but both come after headers and before the body.

Query kinds (per grammar): `status`, `version`, `url`, `ip`, `header`, `certificate`, `cookie`, `body`, `xpath`, `jsonpath`, `regex`, `variable`, `duration`, `redirects`, `bytes`, `sha256`, `md5`. Predicates include `==`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `startsWith`, `endsWith`, `matches`, `exists`, `isBoolean`, `isInteger`, `isFloat`, `isNumber`, `isString`, `isList`, `isObject`, `isIsoDate`, `isIpv4`, `isIpv6`, `isUuid`, `isEmpty`, each optionally negated with `not` (the grammar also parses legacy `includes`, `isCollection`, `isDate` — do not write them; see asserting.md). (Assertion semantics are covered in depth in a separate reference.)

`duration` asserts total response time in milliseconds: `duration < 1000`.

### Body — implicit exact assert

An optional body literal, last, is an implicit *exact* assert on the whole response body. Same literal types as requests (JSON, XML, multiline string, oneline string, `file,...;`, `base64,...;`, `hex,...;`):

    GET https://example.org/api/cats/123
    HTTP 200
    {
      "name" : "Purrslould",
      "species" : "Cat"
    }

For file comparison use an explicit assert instead: `body == file,cat.json;`. For partial matching use `[Asserts]` with `jsonpath`/`includes`.

Captures and asserts operate on the **decompressed** body even when the server returns br/gzip/deflate; raw stdout output stays compressed unless `--compressed`.


## Templates

Placeholder syntax: `{{name}}`. Grammar: `placeholder: {{ expr }}` where `expr: (variable-name | function) (sp filter)*`. Variable names: `[A-Za-z][A-Za-z_-0-9]*`. Filters can be applied inside a placeholder. An undefined variable referenced in a template is a runtime error.

Built-in functions usable in placeholders: `newUuid` (UUID v4), `newDate` (RFC 3339 UTC now), `getEnv`.

### Where templates work

URLs, header values, section key/values (query, form, cookies, options), asserts (both sides, e.g. `jsonpath "$.errors[{{index}}].id"`), and bodies — with one exception: raw XML bodies are not template-aware. To template XML or arbitrary text, fence it in a multiline string (` ``` ` or ` ```xml `), which is template-aware:

    POST https://example.org/echo/post/xml
    ```xml
    <?xml version="1.0" encoding="utf-8"?>
    <Request>
        <Login>{{login}}</Login>
        <Password>{{password}}</Password>
    </Request>
    ```

`file,...;` bodies are sent as-is, never templated.

### Typed rendering in JSON

Quoted `"{{a_string}}"` renders as a string; unquoted `{{a_bool}}` / `{{a_number}}` / `{{a_null}}` render with the variable's type:

    PUT https://example.org/api/hits
    Content-Type: application/json
    {
        "key0": "{{a_string}}",
        "key1": {{a_bool}},
        "key2": {{a_null}},
        "key3": {{a_number}}
    }

The same typing rule applies in asserts: `... == "{{count}}"` compares as string; `... == {{count}}` compares as the variable's type.

### Variable injection routes

1. CLI: `hurl --variable host=example.net --variable id=1234 test.hurl`
2. File: `hurl --variables-file vars.env test.hurl` (lines of `name=value`)
3. Environment: `HURL_VARIABLE_name=value`. (8.0 renamed the variable env prefix — the bare `HURL_name` form is gone.)
4. In-file: `[Options]` section `variable: name=value` — applies to that entry and all subsequent entries.
5. `[Captures]` — captured values become variables for subsequent entries.

Secrets: `hurl --secret token=FooBar` injects a variable whose value is redacted from logs and reports (exact-match redaction; stdout response bodies are NOT redacted). In-file equivalent: append `redact` to a capture.

Escaping a literal `{{` is not documented on the templates page (verified against the live page). Practical guidance: avoid literal `{{` in template-aware contexts, or supply the body via `file,...;`, which is not templated.


<constraints>

## Grammar gotchas

- **Fixed macro-order, free section order.** Request: method/URL → headers → sections → body. Response: status line → headers → sections → body. Within the sections slot, request sections are unordered; response sections are `[Captures]`/`[Asserts]` in either order. Headers can never appear after a section; body must be last.
- **Headers have no section header.** A `key: value` line right after the URL is a header; inside `[Query]` it is a query param. Misplacing one silently changes meaning.
- **No entry separator.** Everything after the status line until the next METHOD line belongs to the response; a new entry starts at the next method keyword.
- **`HTTP` vs `HTTP/1.1` vs `HTTP/2`**: bare `HTTP` matches any protocol version; a versioned form asserts it. `HTTP/3` is accepted by current versions even though the grammar page lists only 1.0/1.1/2.
- **Legacy section names still parse**: `[QueryStringParams]`, `[FormParams]`, `[MultipartFormData]` are grammar-level aliases of `[Query]`, `[Form]`, `[Multipart]`. Author with the new names; recognize both when reading.
- **Body one-liner trailing `;`**: `file,...;`, `base64,...;`, `hex,...;` all require the trailing semicolon.
- **Comment vs value `#`**: `#` starts a comment anywhere outside a quoted/fenced context; escape as `\#` inside header values etc.
- **UTF-8 only**; optional BOM tolerated.
- **`[Form]`/`[Multipart]` vs body are mutually exclusive** — these sections generate the body.
- **`[Options] variable:` leaks forward** by design: defined for that entry and all subsequent entries.
- **Response body literal = exact match** of the whole body (JSON literals compare structurally, but content must be complete — partial matching needs `[Asserts]` with `jsonpath`/`includes`).
- **Compression**: asserts/captures see the decompressed body regardless of `Content-Encoding`; raw stdout does not, unless `--compressed`.
- **Multiline string type tags** are limited to `base64 | hex | json | xml | graphql | raw`; only `graphql` changes request semantics (JSON envelope).
- **Templating reach**: JSON bodies and multiline strings are template-aware; raw XML bodies are not — fence XML in ` ```xml ` to template it. `file,...;` bodies are sent as-is.

</constraints>


## Sources

[^hurl-file]: Hurl docs — Hurl File. <https://hurl.dev/docs/hurl-file.html>
[^entry]: Hurl docs — Entry. <https://hurl.dev/docs/entry.html>
[^request]: Hurl docs — Request. <https://hurl.dev/docs/request.html>
[^response]: Hurl docs — Response. <https://hurl.dev/docs/response.html>
[^templates]: Hurl docs — Templates. <https://hurl.dev/docs/templates.html>
[^grammar]: Hurl docs — Grammar. <https://hurl.dev/docs/grammar.html>
[^samples]: Hurl docs — Samples. <https://hurl.dev/docs/samples.html>

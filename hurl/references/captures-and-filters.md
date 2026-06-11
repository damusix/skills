# Captures and Filters

How to extract values from responses into variables, transform them with filters, and keep secrets out of logs. Verified against Hurl 8.0.1. Queries, predicates, and implicit asserts are covered in [asserting.md](asserting.md) — captures reuse the same query types, so this file does not repeat the query or predicate tables.


## Capture Syntax

Inside a `[Captures]` section, one capture per line:

    variable_name: query [filters...]

A capture is the same `query [filters...]` pipeline as an explicit assert, with a variable name in front instead of a predicate behind. Every query type works in `[Captures]`.

Scope and lifetime:

- Captured variables live for the rest of the **run session** — across entries in the same file and across files in the same run.
- Re-capturing the same name overrides the previous value.
- Captured values are **typed**: string, number, boolean, null, list, object, or bytes. The type comes from the query (and any filters applied).

Use captured variables anywhere via `{{name}}` templates: URLs, headers, bodies, queries, predicate values, even inside JSONPath expressions (`jsonpath "$.errors[{{index}}].id"`).


## Per-Query Capture Examples

Every query is capturable:

    GET https://example.org
    HTTP 200
    [Captures]
    my_status: status
    http_version: version                      # string ("1.1", "2", ...)
    next_url: header "Location"
    session_id: cookie "LSID"
    session_expiry: cookie "LSID[Expires]"     # any cookie attribute works
    my_body: body                              # whole body as text
    my_data: bytes                             # whole body as bytes (after decompression)
    raw_data: rawbytes                         # bytes before content decoding (8.0+)
    pet_id: xpath "normalize-space(//div[@id='pet0'])"
    contact_id: jsonpath "$['id']"
    id_a: regex "id_a:([0-9]+)"                # first capture group
    my_hash: sha256
    my_md5: md5
    landing_url: url
    step1: redirects nth 0 location
    server_ip: ip
    duration_in_ms: duration
    cert_expire: certificate "Expire-Date"
    aliased: variable "my_body"                # copy a variable into another

JSONPath captures preserve structure — objects, lists, nulls, numbers, booleans all keep their type:

    [Captures]
    an_object:  jsonpath "$['an_object']"
    a_list:     jsonpath "$['a_list']"
    a_null:     jsonpath "$['a_null']"
    an_integer: jsonpath "$['an_integer']"
    a_bool:     jsonpath "$['a_bool']"
    all:        jsonpath "$"

XPath captures are not limited to scalars — node-sets can be captured and asserted later via the `variable` query:

    [Captures]
    pets: xpath "//pets"
    [Asserts]
    variable "pets" count == 200


## Variable Flow Between Entries

Capture in one entry, use in the next — the standard CSRF pattern:

    # First GET to fetch the CSRF token:
    GET https://example.org
    HTTP 200
    [Captures]
    csrf_token: xpath "normalize-space(//meta[@name='_csrf_token']/@content)"

    # Use it in the next request:
    POST https://acmecorp.net/login?user=toto&password=1234
    X-CSRF-TOKEN: {{csrf_token}}
    HTTP 302

The same mechanism drives auth-token reuse, pagination cursors, and create-then-fetch flows: capture `header "Location"` or `jsonpath "$.id"` after a `POST`, then template it into the next request line.


## Filters

Filters transform a queried value before the predicate (in asserts) or before storage (in captures). They **chain** left to right; each filter's input type must match the previous output type. A type mismatch is a runtime error (8.0 improved these error messages).

| Filter | Description | Input | Output |
|---|---|---|---|
| `base64Decode` | Base64 string → bytes (RFC 4648 §4) | string | bytes |
| `base64Encode` | bytes → Base64 string | bytes | string |
| `base64UrlSafeDecode` | URL-safe Base64 string → bytes (RFC 4648 §5) | string | bytes |
| `base64UrlSafeEncode` | bytes → URL-safe Base64 string | bytes | string |
| `charsetDecode "<enc>"` | bytes → string using charset (WHATWG encoding labels) — 8.0+ name | bytes | string |
| `count` | number of items in a collection | collection | number |
| `dateFormat "<fmt>"` | date → string (chrono strftime spec) | date | string |
| `daysAfterNow` | days from now until a future date | date | number |
| `daysBeforeNow` | days from a past date until now | date | number |
| `first` | first element | collection | any |
| `htmlEscape` | escape `&`, `<`, `>` | string | string |
| `htmlUnescape` | resolve named/numeric character references | string | string |
| `jsonpath "<expr>"` | evaluate JSONPath against a string value | string | any |
| `last` | last element | collection | any |
| `location` | absolute target URL of a redirection step | response | string |
| `nth <i>` | element at zero-based index; negative indices count from the end | collection | any |
| `regex <pattern>` | extract first capture group (pattern needs >= 1 group) | string | string |
| `replace "<old>" "<new>"` | replace all occurrences of a literal | string | string |
| `replaceRegex <pat> "<new>"` | replace all regex matches | string | string |
| `split "<sep>"` | split into a list of strings | string | collection of string |
| `toDate "<fmt>"` | parse string → date (chrono strftime; `%+` = ISO 8601/RFC 3339) | string | date |
| `toFloat` | convert to float | string \| number | number |
| `toHex` | bytes → hex string | bytes | string |
| `toInt` | convert to integer | string \| number | number |
| `toString` | convert to string | any | string |
| `urlDecode` | resolve %xx escapes | string | string |
| `urlEncode` | percent-encode non-unreserved chars (except `/`) | string | string |
| `urlQueryParam "<name>"` | value of a query parameter in a URL | string | string |
| `utf8Decode` | bytes → string as UTF-8 (7.1+) | bytes | string |
| `utf8Encode` | string → bytes as UTF-8 (7.1+) | string | bytes |
| `xpath "<expr>"` | evaluate XPath against a string value | string | string |

<constraints>

Deprecations and renames — verify before reusing older examples:

- `format` → renamed `dateFormat`. `format` is deprecated; removal planned in a future major version.
- `decode` → renamed `charsetDecode` in 8.0. `decode` is deprecated but still appears in some official examples (`bytes decode "gb2312" ...`).
- The grammar also lists a `charsetEncode` filter that is absent from the docs table — undocumented; don't rely on it.
- `utf8Decode` / `utf8Encode` require Hurl 7.1+.

</constraints>


## Filter Chaining by Theme

<examples>

<example description="Collections: split, count, nth, first, last, negative index">

    GET https://example.org/api
    HTTP 200
    [Asserts]
    header "x-servers" split "," count == 2
    header "x-servers" split "," nth 0 == "rec1"
    header "x-servers" split "," nth 1 == "rec3"
    jsonpath "$.books" count == 12
    jsonpath "$.books" first == "Dune"
    jsonpath "$.books" last == "Les Misérables"
    jsonpath "$.books" nth 2 == "Children of Dune"
    jsonpath "$.books" nth -1 == "Les Misérables"     # negative index from the end

</example>

<example description="Dates: string → date → number/string pipelines">

    [Asserts]
    header "Expires" toDate "%a, %d %b %Y %H:%M:%S GMT" daysBeforeNow > 1000
    jsonpath "$.published" toDate "%+" dateFormat "%A" == "Monday"   # %+ parses ISO 8601 / RFC 3339
    certificate "Expire-Date" daysAfterNow > 15
    cookie "LSID[Expires]" dateFormat "%a, %d %b %Y %H:%M:%S" == "Wed, 13 Jan 2021 22:23:01"

</example>

<example description="Bytes and encoding: base64, hex, charset decoding">

    [Asserts]
    jsonpath "$.token" base64Decode == hex,3c3c3f3f3f3e3e;
    bytes base64Encode == "PDw/Pz8+Pg=="
    bytes base64UrlSafeEncode == "PDw_Pz8-Pg"
    jsonpath "$.bytesInBase64" base64Decode utf8Decode == "Hello World"
    jsonpath "$.beverage" utf8Encode toHex == "636166C3A9"     # "café" as UTF-8 hex
    bytes toHex == "d188d0b5d0bbd0bbd18b"
    bytes charsetDecode "gb2312" xpath "string(//body)" == "你好世界"

</example>

<example description="String surgery: replace, replaceRegex, urlDecode, urlQueryParam, HTML escaping">

    [Captures]
    url: jsonpath "$.url" replace "http://" "https://"
    [Asserts]
    jsonpath "$.ips" replace ", " "|" == "192.168.2.1|10.0.0.20|10.0.0.10"
    jsonpath "$.ips" split ", " count == 3
    jsonpath "$.message" replaceRegex "B[aoi]b" "Dude" == "Welcome Dude!"
    jsonpath "$.encoded_url" urlDecode == "https://mozilla.org/?x=шеллы"
    jsonpath "$.url" urlQueryParam "x" == "шеллы"
    jsonpath "$.text" htmlEscape == "a &gt; b"
    jsonpath "$.escaped_html[1]" htmlUnescape == "Foo © bar 𝌆"

</example>

<example description="Nested documents: JSON inside an HTML attribute, XML inside non-UTF8 bytes">

    [Captures]
    books: xpath "string(//body/@data-books)"
    pet-id: bytes charsetDecode "gb2312" xpath "normalize-space(//div[@id='pet0'])"
    [Asserts]
    variable "books" jsonpath "$[0].name" == "Dune"
    variable "books" jsonpath "$[0].author" == "Franck Herbert"

</example>

<example description="Numeric coercion: toInt, toFloat, toString">

    [Asserts]
    jsonpath "$.id" toInt == 123        # "123" (string) → 123
    jsonpath "$.pi" toFloat == 3.14
    jsonpath "$.count" toString == "42"

</example>

<example description="Regex extraction as a filter (capture group from a header)">

    [Captures]
    param2: header "x-trace" regex "Hello (.*)!"
    param3: header "x-trace" regex /(?i)hello (.*)!/

Two pattern spellings: double-quoted (backslashes escaped: `\\d`) or `/literal/` (no double-escaping, inline flags like `(?i)` work).

</example>

</examples>


## Secrets and Redaction

Static secrets are injected at run time and redacted from logs (`--very-verbose`) and reports:

    hurl --secret pass=sesame-ouvre-toi file.hurl

Other static routes: `--secrets-file <file>` and `HURL_SECRET_foo=...` environment variables (both 7.1+).

Dynamic secrets: append `redact` to a capture to make the captured value a secret from that point on:

    GET https://foo.com
    HTTP 200
    [Captures]
    pass: header "token" redact

Typical uses: bearer tokens after login (`token: jsonpath "$.access_token" redact`), session cookies (`sid: cookie "SESSIONID" redact`).

<constraints>

- Redaction is by **exact match**. If a secret gets transformed (upper-cased, base64-encoded, embedded in a larger string), register each transformed value as its own secret — Hurl will not recognize derived forms.
- Secrets are NOT redacted from the HTTP response printed on standard output (`--include`, `--json`, JSON report response files). Hurl treats stdout as the unaltered run output. Redaction covers logs and reports only.

</constraints>


## Variable Injection Routes

Variables enter a run from captures or from injection:

| Route | Form | Notes |
|---|---|---|
| Capture | `name: query [filters...]` in `[Captures]` | Typed; session-scoped; re-capture overrides |
| CLI variable | `--variable name=value` | One per flag |
| Variables file | `--variables-file vars.env` | One `name=value` per line |
| Environment | `HURL_VARIABLE_name=value` | 8.0 renamed the legacy `HURL_name` form |
| Per-request | `[Options]` section, `variable: name=value` | Scoped to that entry onward |
| CLI secret | `--secret name=value` | Variable + redacted from logs/reports |
| Secrets file | `--secrets-file <file>` | 7.1+ |
| Secret env var | `HURL_SECRET_name=value` | 7.1+ |
| Functions | `{{newUuid}}`, `{{newDate}}` | Generate dynamic values inline |

Template typing applies everywhere a variable is used: `== {{count}}` compares the typed value, `== "{{count}}"` compares its string rendering. See [asserting.md](asserting.md) for the full typing rules.


## Sources

[^capturing]: Hurl docs — Capturing Response. <https://hurl.dev/docs/capturing-response.html>
[^filters]: Hurl docs — Filters. <https://hurl.dev/docs/filters.html>
[^templates]: Hurl docs — Templates. <https://hurl.dev/docs/templates.html>
[^releases]: Hurl GitHub releases — 8.0.0 and 7.1.0 release notes. <https://github.com/Orange-OpenSource/hurl/releases>

# Asserting Responses

Verified against hurl.dev for Hurl 8.0.1. Covers assert anatomy, query types, predicates, implicit vs explicit asserts, and typing gotchas. Captures and the full filter table live in [captures-and-filters.md](captures-and-filters.md).


## Assert line anatomy

An explicit assert line inside an `[Asserts]` section is:

    query [filters...] predicate-function predicate-value

- **query** extracts data from the response: `jsonpath "$.book"`, `header "Vary"`, `status`, ...
- **filters** (zero or more, chainable) transform the queried value before the predicate: `split ","`, `nth 0`, `toInt`, ... Full filter table in [captures-and-filters.md](captures-and-filters.md).
- **predicate** = predicate function (`==`, `contains`, `exists`, ...) plus an optional predicate value. Type-check predicates (`isInteger`, `exists`, ...) take no value.
- Any predicate negates with a `not` prefix: `jsonpath "$.error" not exists`.

Anatomy examples:

    jsonpath "$.book" contains "Dune"
    #  query           pred     value

    jsonpath "$.name" split "," nth 0 == "Herbert"
    #  query           --2 filters----  pred  value

    body matches /\d{4}-\d{2}-\d{2}/

Queries are the shared core of asserts and captures: a capture is `name: query [filters...]`, an assert is `query [filters...] predicate`.

Response-section ordering inside an entry (after `HTTP <status>`):

1. Implicit version/status assert -- the `HTTP 200` line itself (mandatory if a response block is present)
2. Implicit header asserts -- plain `Name: value` lines
3. `[Captures]` and `[Asserts]` sections (optional, unordered between themselves)
4. Implicit body assert -- literal JSON / XML / multiline / base64 / file body

Content-encoding note: all body queries (`body`, `bytes`, `sha256`, `md5`, `jsonpath`, `xpath`, ...) operate **after** `Content-Encoding` decompression -- except `rawbytes`, which sees the raw wire bytes. Text queries (`body`, `jsonpath`, `xpath`, `regex`) additionally decode bytes to string using the `charset` from `Content-Type`.


## Query types

Every query works identically in `[Asserts]` and `[Captures]`.

| Query | Returns | Syntax |
|---|---|---|
| `status` | number | `status` |
| `version` | string (`"1.0"`, `"1.1"`, `"2"`, `"3"`) | `version` |
| `header` | string, or collection if header repeated | `header "<name>"` (name match case-insensitive) |
| `cookie` | string / attribute value | `cookie "<name>"` or `cookie "<name>[<Attribute>]"` |
| `body` | string (decoded text) | `body` |
| `bytes` | bytes (after content decoding) | `bytes` |
| `rawbytes` | bytes (before content decoding) -- 8.0+ | `rawbytes` |
| `jsonpath` | any (string, number, bool, null, list, object) | `jsonpath "<expr>"` |
| `xpath` | string / bool / number / node-set (XPath 1.0 only) | `xpath "<expr>"` |
| `regex` | string (first capture group) | `regex "<pattern>"` or `regex /<pattern>/` |
| `sha256` | bytes (hash of decompressed body) | `sha256` |
| `md5` | bytes (hash of decompressed body) | `md5` |
| `url` | string (last fetched URL; meaningful with redirect following) | `url` |
| `redirects` | collection of redirection steps -- pair with `location` filter | `redirects` |
| `ip` | string (IP of last connection) | `ip` |
| `variable` | the variable's typed value | `variable "<name>"` |
| `duration` | number (total transfer time, ms) | `duration` |
| `certificate` | string/date attribute of the TLS cert | `certificate "<Attribute>"` |

### status

    GET https://example.org
    HTTP *
    [Asserts]
    status < 300

### version

Returns a string:

    [Asserts]
    version == "2"

### header

    GET https://example.org
    HTTP 302
    [Asserts]
    header "Location" contains "www.example.net"
    header "Last-Modified" matches /\d{2} [a-z-A-Z]{3} \d{4}/

Duplicated headers make `header` return a collection:

    [Asserts]
    header "Vary" count == 2
    header "Vary" contains "User-Agent"
    header "Vary" contains "Content-Type"

### cookie

Checks `Set-Cookie` response headers. Attribute syntax `<cookie-name>[<attribute>]`; supported attributes: `Value`, `Expires`, `Max-Age`, `Domain`, `Path`, `Secure`, `HttpOnly`, `SameSite`.

    GET http://localhost:8000/cookies/set
    HTTP 200
    [Asserts]
    cookie "LSID" == "DQAAAKEaem_vYg"
    cookie "LSID[Value]" == "DQAAAKEaem_vYg"   # same as previous
    cookie "LSID[Expires]" exists
    cookie "LSID[Expires]" contains "Wed, 13 Jan 2021"
    cookie "LSID[Max-Age]" not exists
    cookie "LSID[Domain]" not exists
    cookie "LSID[Path]" == "/accounts"
    cookie "LSID[Secure]" exists
    cookie "LSID[HttpOnly]" exists
    cookie "LSID[SameSite]" == "Lax"

`Secure` and `HttpOnly` do NOT return booleans -- they can only be tested with `exists` / `not exists`.

### body

Whole body decoded as text (charset from `Content-Type`):

    [Asserts]
    body contains "<h1>Welcome!</h1>"

If `Content-Type` lacks a charset hint, decode explicitly with the `charsetDecode` filter:

    [Asserts]
    header "Content-Type" == "text/html"
    bytes charsetDecode "gb2312" contains "你好世界"

(Older docs examples spell this `bytes decode "gb2312"` -- `decode` is the deprecated pre-8.0 name of `charsetDecode`.)

### bytes

Body as bytestream, after decompression:

    GET https://example.org/data.bin
    HTTP 200
    [Asserts]
    bytes startsWith hex,efbbbf;
    bytes count == 12424
    header "Content-Length" == "12424"

### rawbytes (8.0+)

Body bytes before any content decoding:

    GET https://example.org/data.bin
    HTTP 200
    Content-Encoding: gzip
    [Asserts]
    header "Content-Length" == "32"
    rawbytes count == 32               # compressed size, matches Content-Length
    bytes count == 100                 # decompressed size
    rawbytes startsWith hex,1f8b;      # gzip magic bytes
    bytes startsWith hex,48656c6c6f;   # decompressed "Hello"

For uncompressed responses, `rawbytes` and `bytes` are identical.

### jsonpath

    GET http://httpbin.org/json
    HTTP 200
    [Asserts]
    jsonpath "$.slideshow.author" == "Yours Truly"
    jsonpath "$.slideshow.slides[0].title" contains "Wonder"
    jsonpath "$.slideshow.slides" count == 2
    jsonpath "$.slideshow.date" != null
    jsonpath "$.slideshow.slides[*].title" contains "Mind Blowing!"

Version note: Hurl 8.0 replaced the JSONPath engine with an implementation of **RFC 9535** (breaking change per the 8.0.0 release notes) -- edge-case expressions may behave differently than pre-8.0.

### xpath

XPath 1.0 only. Result type depends on the expression (string, boolean, number, node-set):

    GET https://example.org
    HTTP 200
    Content-Type: text/html; charset=UTF-8
    [Asserts]
    xpath "string(/html/head/title)" contains "Example"  # string result
    xpath "count(//p)" == 2                              # number result
    xpath "//p" count == 2                               # node-set + count filter
    xpath "boolean(count(//h2))" == false                # boolean result
    xpath "//h2" not exists                              # simpler equivalent

XML namespaces are supported (`_` can be used for the first default namespace):

    [Asserts]
    xpath "string(//bk:book/bk:title)" == "Cheaper by the Dozen"
    xpath "string(//*[local-name()='book']/*[local-name()='title'])" == "Cheaper by the Dozen"

### regex

Asserts on the **first capture group** -- the pattern must have at least one capture group or the assert fails. Two pattern spellings: double-quoted string (backslash metacharacters must be escaped: `\\d`) or `/literal/` regex (no double-escaping). Rust regex syntax; inline flags work, e.g. `(?i)`:

    GET https://example.org/hello
    HTTP 200
    [Asserts]
    regex "^(\\d{4}-\\d{2}-\\d{2})$" == "2018-12-31"
    regex /^(\d{4}-\d{2}-\d{2})$/ == "2018-12-31"   # same, no escaping
    regex /(?i)hello (\w+)!/ == "World"

### sha256 / md5

Hash of the (decompressed) body, compared against a hex byte literal:

    GET https://example.org/data.tar.gz
    HTTP 200
    [Asserts]
    sha256 == hex,039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81;
    md5 == hex,ed076287532e86365e841e92bfc50d8c;

Values are NOT affected by `Content-Encoding` (hash is computed after decompression).

### url

Last fetched URL -- meaningful with redirect following (`[Options] location: true` or `--location`):

    GET https://example.org/redirecting
    [Options]
    location: true
    HTTP 200
    [Asserts]
    url == "https://example.org/redirected"

### redirects

Collection of redirection steps; combine with the `location` filter and `nth`/`count`:

    GET https://example.org/redirecting/1
    [Options]
    location: true
    HTTP 200
    [Asserts]
    redirects count == 3
    redirects nth 0 location == "https://example.org/redirecting/2"
    redirects nth 1 location == "https://example.org/redirecting/3"
    redirects nth 2 location == "https://example.org/redirected"

### ip

IP address of the last connection, as a string. Pairs with `isIpv4` / `isIpv6`:

    [Asserts]
    ip isIpv4
    ip not isIpv6
    ip == "172.16.45.87"

### variable

Asserts on a previously captured variable (capture once, assert many ways):

    GET https://example.org/api/pets
    HTTP 200
    [Captures]
    pets: xpath "//pets"
    [Asserts]
    variable "pets" count == 200

### duration

Total duration (send + receive) in milliseconds:

    [Asserts]
    duration < 1000   # under one second

### certificate

TLS certificate attributes: `Subject`, `Issuer`, `Start-Date`, `Expire-Date`, `Serial-Number`, `Subject-Alt-Name` (8.0+), `Value` (full PEM, 8.0+):

    GET https://example.org
    HTTP 200
    [Asserts]
    certificate "Subject" == "CN=example.org"
    certificate "Issuer" == "C=US, O=Let's Encrypt, CN=R3"
    certificate "Expire-Date" daysAfterNow > 15
    certificate "Serial-Number" matches "[0-9af]+"
    certificate "Subject-Alt-Name" contains "DNS:example.org"
    certificate "Subject-Alt-Name" split "," count == 2
    certificate "Value" startsWith "-----BEGIN CERTIFICATE-----"


## Predicates

| Predicate | Meaning | Example |
|---|---|---|
| `==` | equal (string, number, boolean, null, collection, bytes) | `jsonpath "$.book" == "Dune"` |
| `!=` | not equal | `jsonpath "$.color" != "red"` |
| `>` | number or date greater than | `jsonpath "$.year" > 1978` / `jsonpath "$.createdAt" toDate "%+" > {{a_date}}` |
| `>=` | greater or equal | `jsonpath "$.year" >= 1978` |
| `<` | number or date less than | `jsonpath "$.year" < 1978` |
| `<=` | less or equal | `jsonpath "$.year" <= 1978` |
| `startsWith` | string or bytes prefix | `jsonpath "$.movie" startsWith "The"` / `bytes startsWith hex,efbbbf;` |
| `endsWith` | string or bytes suffix | `jsonpath "$.movie" endsWith "Back"` / `bytes endsWith hex,ab23456;` |
| `contains` | collection membership (string/number element) OR substring/byte-sequence | `jsonpath "$.movie" contains "Empire"` / `jsonpath "$.numbers" contains 42` / `bytes contains hex,beef;` |
| `matches` | regex match on a string (Rust regex syntax) | `jsonpath "$.release" matches /\d{4}/` or `matches "\\d{4}"` |
| `exists` | query returns a value | `jsonpath "$.book" exists` |
| `isBoolean` | value is a boolean | `jsonpath "$.succeeded" isBoolean` |
| `isEmpty` | value is an empty collection (list, object) | `jsonpath "$.movies" isEmpty` |
| `isFloat` | value is a float | `jsonpath "$.height" isFloat` |
| `isInteger` | value is an integer | `jsonpath "$.count" isInteger` |
| `isIpv4` | string is an IPv4 address | `ip isIpv4` |
| `isIpv6` | string is an IPv6 address | `ip isIpv6` |
| `isIsoDate` | string is an RFC 3339 date (`YYYY-MM-DDTHH:mm:ss.sssZ`) | `jsonpath "$.publication_date" isIsoDate` |
| `isList` | value is a list (7.1+) | `jsonpath "$.books" isList` |
| `isNumber` | value is integer or float | `jsonpath "$.count" isNumber` |
| `isObject` | value is an object / XML node-set (7.1+) | `jsonpath "$.books[0]" isObject` |
| `isString` | value is a string | `jsonpath "$.name" isString` |
| `isUuid` | string is a UUID v4 | `jsonpath "$.id" isUuid` |

### Negation

Every predicate negates with a `not` prefix:

    jsonpath "$.book" not contains "Dune"
    cookie "LSID[Domain]" not exists
    ip not isIpv6

### Legacy / grammar-only predicates

The formal grammar (hurl.dev/docs/grammar.html) still parses `includes`, `isCollection`, and `isDate`, but none appear in the documented predicates table. Do not use them in new files:

- `includes` -- legacy collection-membership predicate; covered today by `contains` on collections.
- `isCollection`, `isDate` -- present in the grammar, absent from current docs. Treat as undocumented/legacy; prefer `isList` / `isIsoDate` / `toDate`-based comparisons.

### Predicate value typing rules

Predicate values are **typed**: string, boolean, number, byte literal (`hex,...;` or `base64,...;`), `null`, or a collection.

- `"true"` is a string; `true` is a boolean. `"458"` is a string; `458` is a number. The queried value's type must match:

      xpath "boolean(count(//h1))" == true                    # XPath boolean → unquoted true
      xpath "string(//article/@data-visible)" == "true"       # XPath string → quoted "true"

- `==` works with strings, numbers, booleans, null, collections, and bytes. `startsWith` / `endsWith` work only with strings and bytes; `contains` adds collections; `matches` only with strings. Applying `matches` to a number is a **runtime error** -- convert first (`toString`) or fix the query.
- Comparison predicates `>`, `>=`, `<`, `<=` take a number, a quoted string, or a `{{placeholder}}` (numbers and dates compare naturally; dates via the `toDate` filter).
- `null` is a real predicate value: `jsonpath "$.date" != null`.
- Byte literals: `hex,1f8b;` and `base64,PDw/Pz8+Pg==;` are the byte-typed predicate values (`sha256 == hex,...;`, `bytes startsWith hex,1f8b;`).
- Template typing: `jsonpath "$.id" == "{{count}}"` compares against the *string* rendering of the variable; `jsonpath "$.index" == {{count}}` compares against its *typed* value. Quote the placeholder only when you want a string comparison.


## Implicit asserts vs explicit [Asserts]

### Version/status line (implicit, mandatory when a response block exists)

    HTTP 200          # any HTTP version, status must be 200
    HTTP/2 200        # version must be HTTP/2 AND status 200
    HTTP *            # don't test version or status
    HTTP/1.1 *        # version only (wildcard status)

Versions: `HTTP/1.0`, `HTTP/1.1`, `HTTP/2`, `HTTP/3`, or `HTTP` (any). No status text after the code. Use `HTTP *` plus explicit `status` asserts for ranges:

    HTTP *
    [Asserts]
    status > 400
    status <= 500

### Headers (implicit)

Plain `Name: value` lines right after the status line. Exact, whole-value equality; name comparison case-insensitive; quotes are part of the value (ETag!). The list is not exhaustive -- extra response headers don't fail. Duplicated headers can be tested by repeating the line:

    HTTP 200
    Set-Cookie: theme=light
    Set-Cookie: sessionToken=abc123; Expires=Wed, 09 Jun 2021 10:18:14 GMT

Use the explicit `header` assert instead when you need predicates (`contains`, `startsWith`, `matches`, `exists`) or counting duplicates (`header "Vary" count == 2`).

### Body (implicit)

A literal body after the asserts sections is a whole-body equality assert (sugar for `body ==`). Forms: raw JSON, raw XML, multiline ```` ``` ```` strings (optionally tagged ` ```json ` / ` ```xml `), oneline `` `Hello world!` `` strings, `base64,...;`, `file,...;` (relative to the .hurl file; no `..`; root changeable with `--file-root`). Implicit body asserts are compared after content decoding (compression + charset).

### When to use which

- Implicit: golden-file style full-equality checks, expected redirect `Location`, exact header values, fixed status.
- Explicit `[Asserts]`: partial checks, ranges, regex/predicates, collections, anything filtered, status ranges with `HTTP *`, header counting, body fragments.


<constraints>

## Typing gotchas

- **JSONPath single-node coercion**: the value selected by a JSONPath is coerced to a string when only one node is selected (relevant when a `$..[?(...)]`-style expression yields one match). When an expression returns a collection, use `count`, `contains`, `first`/`last`/`nth`, or `isList`.
- **`jsonpath "$.items[*].name" contains "x"`** works because the query returns a collection of strings; `contains` then means membership, not substring.
- **Numbers vs strings**: `header` values are always strings (`header "Content-Length" == "12424"` -- quoted). JSON numbers are numbers (`jsonpath "$.count" == 42`, unquoted). Use the `toInt`/`toFloat`/`toString` filters to convert when an API returns numeric strings.
- **Booleans**: `true`/`false` unquoted are booleans; `"true"` is a string. XPath `boolean(...)` returns a boolean; XPath `string(...)` and attribute reads return strings.
- **`null`** is a real predicate value -- `jsonpath "$.date" != null`.
- **`matches` on non-strings is a runtime error**; same for any filter input type mismatch (e.g. `count` on a string, `split` on a number).
- **Regex escaping**: in double-quoted patterns, `\d` must be written `\\d`; `/pattern/` literals avoid double-escaping and accept inline flags like `(?i)`.
- **`version` returns a string** (`"2"`, not 2); `status` and `duration` return numbers; `ip` returns a string.
- **Cookie `Secure`/`HttpOnly`** only support `exists`/`not exists` -- they are not booleans.
- **`hex,...;` / `base64,...;` literals** are the byte-typed predicate values (`sha256 == hex,...;`, `bytes startsWith hex,1f8b;`).
- **Templates in asserts**: `== {{count}}` is a typed comparison, `== "{{count}}"` is a string comparison.
- **Bodies are decompressed before all body queries except `rawbytes`** -- `Content-Encoding` never changes assert values, except for `rawbytes` (8.0+).

</constraints>


## Sources

[^asserting]: Hurl docs — Asserting Response. <https://hurl.dev/docs/asserting-response.html>
[^capturing]: Hurl docs — Capturing Response. <https://hurl.dev/docs/capturing-response.html>
[^templates]: Hurl docs — Templates. <https://hurl.dev/docs/templates.html>
[^grammar]: Hurl docs — Grammar. <https://hurl.dev/docs/grammar.html>
[^releases]: Hurl GitHub releases — 8.0.0 and 7.1.0 release notes. <https://github.com/Orange-OpenSource/hurl/releases>

# Recipes

Complete, runnable Hurl examples organized by intent. Verified against Hurl 8.0.1.

<examples>

## Basics

<example description="GET with header, JSON asserts, and a response-time budget">

    GET https://example.org/order
    screencapability: low
    HTTP 200
    [Asserts]
    jsonpath "$.validated" == true
    jsonpath "$.userInfo.firstName" == "Franck"
    jsonpath "$.links" count == 12
    jsonpath "$.state" != null
    jsonpath "$.order" matches /^order-\d{8}$/
    jsonpath "$.created" isIsoDate
    duration < 1000

The `screencapability` line is a request header (headers follow the URL with no section name). `duration` is total transfer time in milliseconds.

</example>

<example description="POST JSON with status check">

    POST https://example.org/api/tests
    {
        "id": "456",
        "evaluate": true
    }
    HTTP 201

A bare JSON body sets `Content-Type: application/json` automatically.

</example>

<example description="HTML form submission">

    POST https://example.org/contact
    [Form]
    default: false
    token: {{token}}
    email: john.doe@rookie.org
    number: 33611223344
    HTTP 302

`[Form]` generates an `application/x-www-form-urlencoded` body — it is mutually exclusive with an explicit body.

</example>

<example description="Query params via [Query] (URL-encoded for you)">

    GET https://example.org/news
    [Query]
    order: newest
    search: something to search
    count: 100
    HTTP 200

Values are written raw; Hurl URL-encodes them. Inline URL params and `[Query]` params combine.

</example>

## Auth

<example description="Basic auth">

    GET https://example.org/protected
    [BasicAuth]
    bob: secret
    HTTP 200

Hurl does the base64 encoding. Suite-wide alternative: `hurl --user bob:secret file.hurl`.

</example>

<example description="Login, capture bearer token with redact, reuse it">

    POST https://api.example.org/v1/auth/login
    {
      "username": "{{username}}",
      "password": "{{password}}"
    }
    HTTP 200
    [Captures]
    token: jsonpath "$.access_token" redact
    [Asserts]
    jsonpath "$.token_type" == "Bearer"
    jsonpath "$.expires_in" isInteger

    GET https://api.example.org/v1/me
    Authorization: Bearer {{token}}
    HTTP 200
    [Asserts]
    jsonpath "$.username" == "{{username}}"

Run: `hurl --variable username=toto --secret password=hunter2 auth.hurl`. `redact` marks the captured token as a secret, scrubbed from `--very-verbose` logs and reports (not from stdout).

</example>

<example description="CSRF flow: harvest token from HTML, log in with it">

    GET http://localhost:3000/login
    HTTP 200
    [Captures]
    csrf_token: xpath "string(//input[@name='_csrf']/@value)"

    POST http://localhost:3000/login
    [Form]
    username: fab
    password: 12345678
    _csrf: {{csrf_token}}
    HTTP 302
    Location: https://example.org/home

Cookies persist across entries automatically, so the session continues with no explicit plumbing. The negative test (POST without `_csrf`, assert `HTTP 403`) is what raw HTTP catches and browser tests can't.

</example>

<example description="AWS SigV4 signed request">

    POST https://sts.eu-central-1.amazonaws.com/
    [Options]
    aws-sigv4: aws:amz:eu-central-1:sts
    user: bob=secret
    [Form]
    Action: GetCallerIdentity
    Version: 2011-06-15

Credentials go through the `user:` option; `aws-sigv4` names provider/region/service.

</example>

<example description="Session cookie attributes after login">

    POST https://example.org/login
    [Form]
    user: toto
    password: 12345678
    HTTP 302
    [Captures]
    sid: cookie "SESSIONID" redact
    [Asserts]
    cookie "SESSIONID" exists
    cookie "SESSIONID[HttpOnly]" exists
    cookie "SESSIONID[Secure]" exists
    cookie "SESSIONID[SameSite]" == "Lax"
    cookie "SESSIONID[Path]" == "/"

`Secure` and `HttpOnly` are not booleans — test them only with `exists` / `not exists`.

</example>


## Chained flows

<example description="Create-then-fetch via Location header">

    POST https://api.example.org/v1/widgets
    {
      "name": "sprocket-{{newUuid}}"
    }
    HTTP 201
    [Captures]
    widget_url: header "Location"
    widget_id: jsonpath "$.id"
    [Asserts]
    jsonpath "$.id" isUuid

    GET {{widget_url}}
    HTTP 200
    [Asserts]
    jsonpath "$.id" == "{{widget_id}}"

`{{newUuid}}` is a built-in generator function; captured variables work in URLs.

</example>

<example description="Pagination cursor walk">

    GET https://api.example.org/v1/items?limit=10
    HTTP 200
    [Captures]
    next_cursor: jsonpath "$.meta.next_cursor"
    first_id: jsonpath "$.data[0].id"
    [Asserts]
    jsonpath "$.data" count <= 10
    jsonpath "$.meta.next_cursor" isString

    GET https://api.example.org/v1/items?limit=10&cursor={{next_cursor}}
    HTTP 200
    [Asserts]
    jsonpath "$.data" count <= 10
    jsonpath "$.data[0].id" != "{{first_id}}"

Page 2 must start with a different record than page 1 — a cheap invariant that catches cursor bugs.

</example>

<example description="Poll an async job until completed (retry as wait-condition)">

    POST https://api.example.org/jobs
    HTTP 201
    [Captures]
    job_id: jsonpath "$.id"
    [Asserts]
    jsonpath "$.state" == "RUNNING"

    GET https://api.example.org/jobs/{{job_id}}
    [Options]
    retry: 10
    retry-interval: 500ms
    HTTP 200
    [Asserts]
    jsonpath "$.state" == "COMPLETED"

Retries trigger on assert failures, so the assert is the wait-condition. `retry: -1` retries without limit.

</example>


## Asserting deeply

<example description="JSON API smoke test">

    GET https://api.example.org/v1/users/42
    HTTP 200
    Content-Type: application/json; charset=utf-8
    [Asserts]
    jsonpath "$.id" == 42
    jsonpath "$.email" matches /^[^@]+@[^@]+$/
    jsonpath "$.roles" isList
    jsonpath "$.roles" count >= 1
    jsonpath "$.roles" contains "member"
    jsonpath "$.created_at" isIsoDate
    jsonpath "$.deleted_at" == null
    duration < 2000

JSON numbers compare unquoted (`== 42`); header values are always strings. `isList` requires Hurl 7.1+.

</example>

<example description="XML API testing with XPath, including namespaces">

    GET https://api.example.org/v1/catalog.xml
    HTTP 200
    [Asserts]
    xpath "//book" count == 12
    xpath "string(//book[1]/title)" == "XML Developer's Guide"
    xpath "number(//book[1]/price)" == 44.95
    xpath "boolean(//book[@id='bk999'])" == false
    xpath "//book[price > 40]" count == 3
    [Captures]
    first_book_id: xpath "string(//book[1]/@id)"

XPath 1.0 only; result type follows the expression (`string(...)` → string, `count(...)` → number). Namespaced documents work too:

    [Asserts]
    xpath "string(//bk:book/bk:title)" == "Cheaper by the Dozen"
    xpath "string(//*[local-name()='book']/*[local-name()='title'])" == "Cheaper by the Dozen"

</example>

<example description="Regex extraction from a text/HTML body">

    GET https://example.org/build/status
    HTTP 200
    [Captures]
    build_id: regex /build-id: ([a-f0-9]{8})/
    version: regex "version: (\\d+\\.\\d+\\.\\d+)"
    [Asserts]
    body matches /status: (passed|running)/
    regex /elapsed: (\d+)s/ toInt < 600

`regex` captures/asserts the first capture group — the pattern must have one. `/literal/` patterns avoid the double-escaping that double-quoted patterns require.

</example>

<example description="Redirect chain audit">

    GET http://example.org
    [Options]
    location: true
    HTTP 200
    [Asserts]
    redirects count == 2
    redirects nth 0 location == "https://example.org/"
    redirects nth -1 location == "https://www.example.org/"
    url == "https://www.example.org/"

Redirects are not followed by default — `location: true` enables it per entry. `redirects` lists the hops; `url` is the final effective URL. Manual alternative: one entry per hop, asserting `HTTP 301` and the `Location` header.

</example>

<example description="Date and expiry checks">

    GET https://api.example.org/v1/session
    HTTP 200
    [Asserts]
    jsonpath "$.expires_at" isIsoDate
    jsonpath "$.expires_at" toDate "%+" daysAfterNow > 0
    jsonpath "$.expires_at" toDate "%+" daysAfterNow <= 30
    header "Expires" toDate "%a, %d %b %Y %H:%M:%S GMT" daysAfterNow > 0
    certificate "Expire-Date" daysAfterNow > 15

`toDate` parses with chrono strftime specifiers; `%+` means ISO 8601 / RFC 3339. `certificate` queries the TLS cert directly.

</example>

<example description="Binary artifact integrity (size, hash, wire bytes)">

    GET https://downloads.example.org/cli-v2.1.0.tar.gz
    HTTP 200
    [Asserts]
    bytes count == 1048576
    sha256 == hex,039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81;
    rawbytes startsWith hex,1f8b;

`sha256` hashes the decompressed body. `rawbytes` (Hurl 8.0+) sees the bytes before content decoding — here, the gzip magic bytes on the wire. Byte literals (`hex,...;`) require the trailing semicolon.

</example>


## File uploads

<example description="Multipart file upload">

    POST https://example.org/upload
    [Multipart]
    field1: value1
    field2: file,example.txt;
    field3: file,example.zip; application/zip
    HTTP 200

File field syntax is `name: file,filename;` with an optional content type after the `;`. Files resolve relative to the Hurl file's directory (override with `--file-root`).

</example>

<example description="Hand-rolled multipart body with explicit boundary">

    POST https://example.org/upload
    Content-Type: multipart/form-data; boundary="boundary"
    ```
    --boundary
    Content-Disposition: form-data; name="key1"

    value1
    --boundary
    Content-Disposition: form-data; name="upload1"; filename="data.txt"
    Content-Type: text/plain

    Hello World!
    --boundary--
    ```

For exotic cases `[Multipart]` can't express — the multiline string is the body verbatim.

</example>

<example description="GraphQL request">

    POST https://example.org/starwars/graphql
    ```graphql
    query Hero($episode: Episode, $withFriends: Boolean!) {
      hero(episode: $episode) {
        name
        friends @include(if: $withFriends) {
          name
        }
      }
    }

    variables {
      "episode": "JEDI",
      "withFriends": false
    }
    ```
    HTTP 200

The `graphql` multiline tag makes Hurl wrap query and variables into the standard `{"query": ..., "variables": ...}` JSON envelope.

</example>


## Running

<example description="Run one file (curl-like default mode)">

    hurl session.hurl

Executes all entries sequentially, prints the last response body to stdout. Asserts run even without `--test`. Debug output goes to stderr, never stdout.

</example>

<example description="Test a directory">

    hurl --test test/integration/

Directory arguments recurse for `.hurl` files. In `--test` mode files run in parallel by default (entries within a file stay sequential) — pin `--jobs 1` if files share server-side state. Exit code 0 only when every file passes; 4 on assert failure.

</example>

<example description="CI run with JUnit and HTML reports">

    rm -rf build/hurl-report build/hurl-junit.xml
    hurl --test \
         --report-junit build/hurl-junit.xml \
         --report-html build/hurl-report/ \
         --variable host=https://api.staging.example.org \
         --error-format long \
         --glob "test/integration/**/*.hurl"

Reports are cumulative — clean them first or successive runs merge. `--error-format long` logs failing response headers and body into the CI log. Quote `--glob` patterns so the shell doesn't expand them.

</example>

<example description="Env-specific variables file plus secret injection">

    # vars/staging.env
    host=https://staging.example.net
    id=1234

    hurl --test --variables-file vars/staging.env --secret token=$API_TOKEN test/integration/

One variables file per environment, selected by the CI job. Tokens go in as `--secret` (or `HURL_SECRET_token=...`), not `--variable`, so they are redacted from verbose logs and reports — stdout is not redacted. Precedence, lowest to highest: `HURL_VARIABLE_*` env vars → CLI flags → in-file `[Options]`.

</example>

<example description="Debug a failing entry">

    # Full request/response bodies on stderr, stop at entry 3 (1-based)
    hurl --very-verbose --to-entry 3 --color session.hurl

    # Or keep going past the failure with headers in the output
    hurl --continue-on-error --include session.hurl

Scope debug noise to one entry instead with `[Options] verbose: true` in that entry. `--interactive` was removed in 8.0 — entry slicing and per-entry options are the replacements.

</example>

<example description="Convert curl to Hurl and back">

    # curl command → Hurl file
    echo "curl -X POST https://api.example.org/users -H 'Content-Type: application/json' -d '{\"name\":\"bob\"}'" \
      | hurlfmt --in curl -o create-user.hurl

    # Export what Hurl actually ran as curl commands, for replay outside Hurl
    hurl --curl repro-commands.txt session.hurl

curl import lives on `hurlfmt` (`--in curl`); curl export lives on `hurl` (`--curl FILE`). Verbose runs also print the equivalent curl command per request.

</example>

<example description="Publish a Hurl file as HTML documentation">

    hurlfmt --out html --standalone login.hurl -o docs/api/login.html

`--standalone` emits a full styled page instead of a fragment — a well-commented suite doubles as browsable, executable API docs. Related: `hurlfmt --check tests/*.hurl` as a CI format lint, `hurlfmt --out json file.hurl | jq` for structured export.

</example>


## CI snippets

<example description="integration.sh readiness gate: poll until the server is up, then test">

    #!/bin/sh
    set -eu
    # $1 = base URL, e.g. http://localhost:3000

    docker run --name app -d -p 3000:3000 my-app:latest

    # Readiness gate: a one-liner Hurl file from stdin, retried until 200
    printf 'GET %s\nHTTP 200' "$1" | hurl --retry 60 --retry-interval 2s

    hurl --test --variable host="$1" test/integration/

    docker stop app

The retry mechanism doubles as a wait-for-server gate: the implicit `HTTP 200` assert fails until the app answers, and each failure triggers a retry.

</example>

<example description="Minimal GitHub Actions job">

    name: CI

    on:
      push:
        branches:
          - main

    jobs:
      build:
        runs-on: ubuntu-latest
        permissions:
          contents: read
        steps:
          - name: Checkout
            uses: actions/checkout@v4
          - name: Integration test
            env:
              HURL_SECRET_token: ${{ secrets.API_TOKEN }}
            run: |
              curl --location --remote-name https://github.com/Orange-OpenSource/hurl/releases/download/8.0.1/hurl_8.0.1_amd64.deb
              sudo dpkg -i hurl_8.0.1_amd64.deb
              bin/integration.sh http://localhost:3000

Install via pinned `.deb` download (the documented route — the `gacts/install-hurl` action is archived). `HURL_SECRET_*` env vars feed CI secret stores straight into redacted Hurl secrets. Non-zero exit codes fail the step naturally; no wrapper needed.

</example>

</examples>


## Sources

[^samples]: Hurl docs — Samples. <https://hurl.dev/docs/samples.html>
[^asserting]: Hurl docs — Asserting Response. <https://hurl.dev/docs/asserting-response.html>
[^capturing]: Hurl docs — Capturing Response. <https://hurl.dev/docs/capturing-response.html>
[^running-tests]: Hurl docs — Running Tests. <https://hurl.dev/docs/running-tests.html>
[^manual]: Hurl manual. <https://hurl.dev/docs/manual.html>
[^ci-cd]: Hurl tutorial — CI/CD Integration. <https://hurl.dev/docs/tutorial/ci-cd-integration.html>

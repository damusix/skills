# Testing Workflows

Suite organization, CI integration, debugging, and documentation patterns for Hurl test suites. Verified against Hurl 8.0.1 (2026-04).


## Suite organization

One file = one user flow, not one file per request. Entries within a file run sequentially and share cookie storage and captured variables — a login → act → verify scenario belongs in a single file. Independent flows go in separate files because `--test` runs files in parallel by default.

There is no test-name filter. Selective runs work through folder/prefix organization plus globs:

    # Explicit files
    hurl --test a.hurl b.hurl c.hurl

    # Shell wildcard
    hurl --test test/integration/*.hurl

    # Directory recursion (finds .hurl files)
    hurl --test test/integration/

    # Glob patterns (quote to prevent shell expansion)
    hurl --test --glob "test/integration/**/*.hurl"

    # Tagged subsets via folder convention
    hurl --test critical/*.hurl

Suggested layout:

    test/integration/
      basic.hurl            # smoke: server up, key pages 200
      login.hurl            # one flow per file
      search.hurl
      security.hurl
      vars/                 # per-environment variable files
        local.env
        staging.env

Comments start with `#`. A file with only requests (no response blocks) is valid — useful for data retrieval scripts, not tests.


## Incremental authoring

<workflow>

1. Start with a status-only smoke check — proves the server is reachable before any assertion logic:

        # Check that the server is up and running.
        GET http://localhost:3000
        HTTP 200

2. Add an `[Asserts]` section after the status line:

        GET http://localhost:3000
        HTTP 200
        [Asserts]
        xpath "string(//head/title)" == "Movies Box"
        xpath "//h3" count == 2
        header "Content-Type" == "text/html; charset=utf-8"

   Implicit vs explicit header asserts: a response header line (`Content-Type: text/html; charset=utf-8`) checks the exact value only; the explicit `header "..." <predicate>` form allows any predicate (`contains`, `startsWith`, `matches`, ...). Predicates are typed: `== true` (boolean) is not `== "true"` (string).

3. Chain entries into flows within one file. JSON APIs use `jsonpath`:

        GET http://localhost:3000/api/health
        HTTP 200
        [Asserts]
        jsonpath "$.status" == "RUNNING"
        jsonpath "$.healthy" == true
        jsonpath "$.operationId" exists

   Use `[Query]` for query parameters instead of inline URL noise:

        GET http://localhost:3000/api/search
        [Query]
        q: 1982
        sort: name
        HTTP 200

   Filters compose with predicates:

        jsonpath "$[0].release_date" regex /(\d{4})-\d{2}-\d{2}/ == "1982"

4. Run the suite with `hurl --test` to get the recap (parallel files, per-file pass/fail, request counts, durations).

</workflow>


## Retry-until: polling async APIs

Every entry can be retried upon assert, capture, or runtime errors. Because assert failures trigger the retry, asserts double as wait conditions — the canonical pattern for eventually-consistent or job-queue APIs:

    GET http://api.example.org/jobs/{{job_id}}
    [Options]
    retry: 10
    retry-interval: 300ms
    HTTP 200
    [Asserts]
    jsonpath "$.state" == "COMPLETED"

Global equivalents: `--retry <NUM>` (0 = none, -1 = unlimited; env `HURL_RETRY`) and `--retry-interval <DURATION>` (default 1000ms; accepts `2s`, `500ms`; env `HURL_RETRY_INTERVAL`).

The same mechanism gates on server readiness in CI — a one-liner Hurl file from stdin:

    printf 'GET %s\nHTTP 200' "$BASE_URL" | hurl --retry 60 --retry-interval 2s

Other per-entry `[Options]` flow control: `skip: true` (bypass an entry), `delay: 2s` (sleep before request), `repeat: N`, `location: true` / `location-trusted: true` (per-entry redirect following), `verbose: true` / `very-verbose: true`, `output: -`, `variable: name=value`.


## Environment handling

Never hardcode hosts. Template the base URL and inject per environment:

    GET {{host}}/api/health
    HTTP 200

Four injection mechanisms:

1. CLI flag: `hurl --variable host=example.net --variable id=1234 test.hurl`
2. Variables file (`name=value`, one per line; duplicate definitions are an error):

        # vars/staging.env
        host=https://staging.example.net
        id=1234

        hurl --test --variables-file vars/staging.env test/integration/

3. Environment variables with the `HURL_VARIABLE_` prefix:

        export HURL_VARIABLE_host=https://staging.example.net
        hurl --test test/integration/

4. In-file `[Options] variable: host=http://localhost:3000` — defaults the CLI can override.

Environment switching = one variables file per environment (`local.env`, `staging.env`, `prod.env`) selected by the CI job or a wrapper script that takes the base URL as `$1` and passes `--variable host="$1"`.

Captured variables keep their type: `jsonpath "$.id" == {{count}}` compares typed (integer); `== "{{count}}"` compares as string. JSON bodies template with type preservation:

    {
        "key0": "{{a_string}}",
        "key1": {{a_bool}},
        "key2": {{a_null}},
        "key3": {{a_number}}
    }

Built-in generator functions usable anywhere a variable is: `{{newUuid}}` (UUID v4), `{{newDate}}` (RFC 3339 UTC now). The template system does no arithmetic or expressions — `{{ }}` resolves variables and those functions only. Compute values in shell, inject via `--variable` or `HURL_VARIABLE_*`.


## CI integration

### Exit-code contract

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Failed to parse command-line options |
| 2 | Input file parsing error |
| 3 | Runtime error (e.g. failure to connect to host) |
| 4 | Assert error |

Any non-zero code fails the CI step naturally; no wrapper needed. `--continue-on-error` keeps executing entries within a file after an assert error (CLI-only; does not change multi-file behavior).

### Integration script pattern

A `bin/integration.sh` that:

1. Starts the app container (`docker run`)
2. Waits for readiness by polling with retry: `printf 'GET %s\nHTTP 200' "$1" | hurl --retry "$2"`
3. Runs the suite with the host injected: `hurl --test --variable host="$1" test/integration/`
4. Stops the container

### GitHub Actions

Install via direct `.deb` download + `dpkg -i`, pinned to a current version (8.0.1 below). The community installer action `gacts/install-hurl` was archived 2026-06 (read-only) — prefer the documented direct download, or `cargo install hurl` / `brew install hurl` on other runners.

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
          - name: Build
            run: echo "Building app..."
          - name: Integration test
            run: |
              curl --location --remote-name https://github.com/Orange-OpenSource/hurl/releases/download/8.0.1/hurl_8.0.1_amd64.deb
              sudo dpkg -i hurl_8.0.1_amd64.deb
              bin/integration.sh http://localhost:3000

### GitLab CI

    image: docker:24

    build:
       stage: build
       services:
          - docker:24-dind
       before_script:
          # Add Hurl on Alpine (testing channel)
          - apk add --no-cache --repository http://dl-cdn.alpinelinux.org/alpine/edge/testing hurl
       script:
          - bin/integration.sh http://docker:3000

Note the hostname: `http://docker:3000`, not `localhost` — under Docker-in-Docker the app container is reachable via the `docker` service host.


## Report wiring

All report flags are CLI-only and append to / update existing report files — successive runs accumulate. Clean the report path in CI for a fresh per-run report.

| Format | Flag | Output |
|--------|------|--------|
| JUnit XML | `--report-junit FILE` | single XML file — feed to CI test-report ingestion (GitLab `artifacts:reports:junit`, Jenkins, etc.) |
| TAP | `--report-tap FILE` | Test Anything Protocol file |
| HTML | `--report-html DIR` | browsable dashboard + per-file run views (publish as CI artifact / Pages) |
| JSON | `--report-json DIR` | `report.json` with structured results and response dumps |

    hurl --test \
      --report-junit build/hurl-junit.xml \
      --report-html build/hurl-report/ \
      --variables-file vars/staging.env \
      test/integration/

Pair with `--error-format long` in CI so failed asserts log response headers and body into the job output.


## Debugging

`--interactive` was removed in Hurl 8.0.0. The modern toolkit:

- `--verbose`: per-entry debug info — request headers (`>` prefix), response headers (`<` prefix), debug lines (`*` prefix), cookie storage, durations. No bodies.

        hurl --verbose --no-output basic.hurl

- `--very-verbose`: everything above plus request/response bodies, libcurl logs, and response timings.

        hurl --very-verbose --no-output basic.hurl

- Per-entry verbosity keeps the rest of the run quiet:

        GET http://localhost:3000/api/search
        [Options]
        verbose: true
        [Query]
        q: 1982

- `--error-format long`: on assert failure, logs response headers and body (short by default). Recommended default for `--test` runs in CI:

        hurl --error-format long --test basic.hurl

- curl replay: verbose output includes the equivalent curl command per request (copy-paste to replay a failing request). `--curl <FILE>` exports the whole run as a list of curl commands:

        hurl --curl /tmp/curl.txt basic.hurl

- Entry slicing for bisection (1-based indexing): `--from-entry N` / `--to-entry N`:

        hurl -i --to-entry 2 basic.hurl

- `-i` / `--include`: print response headers of the last entry, curl-style.
- Per-entry response dump even in test mode: `[Options]` / `output: -` (writes that entry's body to stdout; a file path writes to file).
- Proxy interception: `hurl --proxy localhost:8888 basic.hurl` (e.g. through mitmproxy).
- `--report-json DIR` doubles as a debug artifact: full structured run data including response dumps.

Timing budgets: assert `duration < 1200` (milliseconds) in `[Asserts]`; inspect breakdown with `hurl --json foo.hurl | jq '.timings'` (`connect`, `name_lookup`, `start_transfer`, `total`).


## Security testing patterns

Hurl operates below the browser, so it tests the server contract, not the UI:

- **Validation bypass**: submit input that client-side validation would block (e.g. a 2-char username when the minimum is 3) — the server must still reject it.
- **CSRF negative test**: POST without the CSRF token and assert `HTTP 403`. Headless-browser tests cannot catch this (browsers auto-include the token); raw HTTP can.
- **CSRF positive flow** (capture then submit; cookies persist across entries automatically, so the session continues without explicit plumbing):

        # Fetch login page, harvest the CSRF token
        GET http://localhost:3000/login
        HTTP 200
        [Captures]
        csrf_token: xpath "string(//input[@name='_csrf']/@value)"

        # Log in with the token
        POST http://localhost:3000/login
        [Form]
        username: fab
        password: 12345678
        _csrf: {{csrf_token}}
        HTTP 302

- **Information-leak detection**: assert production HTML carries no comments: `xpath "//comment" count == 0`.
- **Cookie-flag asserts**: cookie attributes are assertable via the `cookie` query (e.g. `cookie "session[HttpOnly]" exists`, `cookie "session[Secure]" exists`).

Auth mechanics: `--user <USER:PASSWORD>` adds basic auth to each request (env `HURL_USER`); bearer/API-key auth is just a header line (`Authorization: Bearer {{token}}`); `--netrc` reads `~/.netrc`; `--aws-sigv4` signs with AWS SigV4. TLS: `--insecure`, `--cacert <FILE>`. `--location-trusted` re-sends credentials to redirect targets (dangerous; opt-in).

Secrets: tokens and passwords go in as secrets, not plain variables, whenever `--verbose`, `--error-format long`, or reports are in play — otherwise they leak into CI logs and artifacts. `--secret name=value` defines a variable whose value is redacted (exact-match) from logs, error output, and reports; `--secrets-file <FILE>` takes `name=value` lines. The env form is the natural fit for CI secret stores:

    env:
      HURL_SECRET_token: ${{ secrets.API_TOKEN }}


## Hurl files as executable documentation

The format is deliberately human-first — plain text, more readable than curl commands, no JS runtime. A well-kept suite doubles as the API's request/response contract documentation:

- `#` comments narrate intent per entry.
- One named flow per file; the filename is the doc title (`login.hurl`, `search.hurl`).
- Prefer structured sections over inline noise: `[Query]` instead of query strings in the URL, `[Form]` for form posts — they read as key/value tables.
- Asserts state the contract explicitly: `jsonpath "$.healthy" == true` documents the field and its type.

Tooling via hurlfmt (ships with Hurl):

    hurlfmt --check tests/*.hurl                              # CI lint gate: exit 0 if formatted, 1 otherwise
    hurlfmt --in-place file.hurl                              # rewrite in place
    hurlfmt --out html --standalone login.hurl -o docs/api/login.html   # publishable HTML doc
    hurlfmt test.hurl --out json | jq                         # structured export for tooling
    hurlfmt --in curl curls.txt                               # curl -> hurl migration

`--check` cannot combine with `--output`. `--standalone` emits a full styled document instead of a fragment.

The `--report-html DIR` run report complements the static export: rendered files plus actual run results (pass/fail, timings) — documentation that proves itself on every CI run.


## Pitfalls

<constraints>

- **Cookies persist within a file, not across files.** Entries share cookie storage by default (session simulation); disable with `--no-cookie-store`, import/export with `--cookie <FILE>` / `--cookie-jar <FILE>` (Netscape format). Files are isolated from each other — and run in parallel.
- **Redirects are not followed by default.** Three strategies: (1) assert each hop as its own entry (`HTTP 301` + `Location:` header assert, then GET the target); (2) `--location` or per-entry `[Options] location: true` — asserts then apply to the final response; `--max-redirs` caps hops (default 50); (3) with following enabled, the `redirects` query asserts the chain (`redirects count == 2`) and `url` gives the final effective URL. `--location-trusted` additionally forwards credentials to redirect hosts.
- **Asserts run even without `--test`.** `--test` only adds the recap and suppresses body output. `--no-assert` skips assertion evaluation entirely.
- **Reports append.** Every `--report-*` flag updates an existing report rather than overwriting — clean the path in CI for per-run reports.
- **`--repeat` multiplies files, not requests.** `hurl --test --repeat 1000 stress.hurl` schedules 1000 file runs across the worker pool; balance with `--jobs` to avoid TCP port exhaustion. Per-entry repetition is `[Options] repeat: 3`.
- **Parallelism trap.** `--test` runs files in parallel by default (worker count = CPU count); suites written assuming inter-file ordering break nondeterministically. Fix the files or pin `--jobs 1`. Outside test mode, `--parallel` opts in (default there is sequential).
- **Typed predicates.** `== true` is a boolean compare, `== "true"` a string compare; quoting `{{var}}` in an assert forces string comparison. Implicit header lines in a response block are exact-match only — use explicit `header "Name" <predicate>` for anything else.
- **Entry indexing is 1-based** for `--from-entry` / `--to-entry`.
- **No test-name filter exists.** The supported selection pattern is directory/prefix organization plus globs (`hurl --test critical/*.hurl`).
- **libcurl inheritance.** Hurl is built on libcurl and inherits its features and limitations — HTTP version negotiation, proxies, TLS behavior, and encodings follow libcurl semantics (per-entry/CLI options exist to force versions, e.g. HTTP/1.1 vs HTTP/2, mirroring curl flags). On macOS, a custom libcurl (e.g. Homebrew's) can be wired in with `install_name_tool`.
- **Duplicate variable definitions error** in `--variables-file` / `--secrets-file` — environment files must not redefine names.

</constraints>


## Sources

[^running-tests]: Hurl docs — Running Tests. <https://hurl.dev/docs/running-tests.html>
[^entry]: Hurl docs — Entry (retry semantics). <https://hurl.dev/docs/entry.html>
[^templates]: Hurl docs — Templates. <https://hurl.dev/docs/templates.html>
[^manual]: Hurl manual. <https://hurl.dev/docs/manual.html>
[^faq]: Hurl docs — Frequently Asked Questions. <https://hurl.dev/docs/frequently-asked-questions.html>
[^ci-cd]: Hurl tutorial — CI/CD Integration. <https://hurl.dev/docs/tutorial/ci-cd-integration.html>
[^debug]: Hurl tutorial — Debug Tips. <https://hurl.dev/docs/tutorial/debug-tips.html>
[^security]: Hurl tutorial — Security. <https://hurl.dev/docs/tutorial/security.html>
[^captures]: Hurl tutorial — Captures. <https://hurl.dev/docs/tutorial/captures.html>

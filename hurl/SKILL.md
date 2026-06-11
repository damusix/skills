---
name: hurl
description: "Write and run HTTP API tests in Hurl's plain-text format. Use when testing REST/GraphQL APIs, writing integration or smoke tests for HTTP endpoints, chaining requests with captured values, polling async APIs, converting curl commands into maintainable tests, or producing executable API documentation. Trigger on .hurl files, the hurl or hurlfmt CLI, jsonpath/xpath response assertions, or any ask to 'test an API' with a simple text-based tool."
---

# Hurl

Hurl runs HTTP requests defined in a plain-text format and asserts on the responses. One binary (`hurl`, built on libcurl), one readable file format: a `.hurl` file is a sequence of entries, each a request plus an optional response spec with asserts and captures. The same files work as smoke tests, integration tests, CI gates, and living API documentation — they read like the API contract they verify.

Current version: 8.0.1. Reference material in this skill is verified against hurl.dev for that release.

A minimal entry:

    GET https://api.example.org/health
    HTTP 200
    [Asserts]
    jsonpath "$.status" == "RUNNING"

Entries in one file run sequentially and share cookies and captured variables (session behavior). Files are independent and run in parallel under `--test`. That asymmetry drives all suite design: one user flow per file.

<constraints>

1. **Header vs section placement changes meaning.** `key: value` lines directly after the URL are request headers — no section name. The same line inside `[Query]` is a query parameter. Body always comes last; `[Form]`/`[Multipart]` *are* the body and exclude a literal one.
2. **Use current section names** `[Query]`, `[Form]`, `[Multipart]`. The legacy `[QueryStringParams]`/`[FormParams]`/`[MultipartFormData]` still parse — recognize them, don't write them.
3. **Predicates are typed.** `== true` is a boolean check, `== "true"` a string check; `== 458` number, `== "458"` string. Same rule for templates: `== {{count}}` compares typed, `== "{{count}}"` as string. `matches` on a non-string is a runtime error — convert with `toInt`/`toString` first.
4. **`HTTP 200` is itself an assert** (any version, status 200). `HTTP/2 200` also asserts the protocol. Use `HTTP *` plus explicit `status >= 200` asserts for ranges. Asserts run with or without `--test` — test mode only changes output and adds the recap.
5. **Redirects are not followed by default.** Either assert each hop as its own entry, or set `[Options] location: true` (or `--location`) and assert on the final response — then `redirects count`/`redirects nth 0 location` audit the chain and `url` gives the final URL.
6. **`retry` turns asserts into wait conditions.** `[Options] retry: 10` + `retry-interval: 500ms` re-runs the entry until its asserts pass — the polling primitive for async jobs and server-readiness gates. Retries trigger on assert, capture, and runtime errors.
7. **Option precedence is env < CLI flag < `[Options]` section.** `[Options]` applies to its entry only, except `variable:` which persists to later entries. `skip: true` exists only in `[Options]`; `--test`, `--report-*`, `--variables-file`, `--secret` are CLI-only.
8. **Secrets, not variables, for credentials.** `--secret name=value`, `HURL_SECRET_name`, or a trailing `redact` on a capture redacts the value from logs and reports. Redaction is exact-match (register transformed variants separately) and does NOT apply to stdout or JSON-report response dumps.
9. **Reports accumulate.** Every `--report-html/json/junit/tap` appends to an existing report. Clean the report path at the start of each CI run.
10. **Regex literals beat quoted patterns.** `/^\d{4}$/` needs no double escaping; `"^\\d{4}$"` does. The `regex` query and filter assert/extract the **first capture group** — a pattern without a group fails.
11. **Templates resolve variables only** — `{{host}}`, `{{newUuid}}`, `{{newDate}}`; no arithmetic or expressions. Compute in shell and inject with `--variable` or `HURL_VARIABLE_name`. Raw XML bodies are not template-aware; fence them as ```` ```xml ```` multiline strings to template them.
12. **8.0 changes to honor:** JSONPath engine is now RFC 9535 (edge cases differ from pre-8.0), `--interactive` was removed (use `--from-entry`/`--to-entry`, per-entry `[Options] verbose: true`, `--curl` replay), env vars are `HURL_VARIABLE_name` (old bare `HURL_name` form is gone), `decode`/`format` filters are deprecated for `charsetDecode`/`dateFormat`.

</constraints>

<workflow>

Build files incrementally — each step is runnable, so verify as you go.

1. **Smoke first.** One entry, status only: `GET {{host}}/health` + `HTTP 200`. Run it: `hurl --variable host=http://localhost:3000 health.hurl`.
2. **Add asserts.** Tighten the contract with `[Asserts]`: `jsonpath`/`xpath`/`header` queries, typed predicates. Prefer explicit asserts over an exact body literal unless you want golden-file equality.
3. **Chain the flow.** Capture what later entries need (`[Captures]` `token: jsonpath "$.access_token" redact`), use it via `{{token}}`. Cookies flow automatically.
4. **Handle async.** Entries that poll get `[Options] retry: N` + `retry-interval`, with the completion condition as an assert.
5. **Parameterize.** Replace hosts and credentials with `{{variables}}`; create per-environment variables files (`vars/local.env`, `vars/staging.env`); pass tokens as secrets.
6. **Run as a suite.** `hurl --test tests/` (parallel files, recap, exit code 4 on assert failure). Add `--error-format long` so failures log the actual response.
7. **Wire CI.** `--report-junit` for ingestion, `--report-html` for humans; clean report paths first; gate readiness with a stdin one-liner: `printf 'GET %s\nHTTP 200' "$URL" | hurl --retry 60 --retry-interval 2s`.

When a file fails: re-run with `--very-verbose --to-entry N` to isolate the entry with full bodies on stderr, or `hurl --curl repro.txt file.hurl` to export the exact requests as curl commands.

</workflow>

<examples>

<example description="Login, capture a token, reuse it — one flow per file">

    POST {{host}}/api/login
    {"username": "{{user}}", "password": "{{password}}"}
    HTTP 200
    [Captures]
    token: jsonpath "$.access_token" redact

    GET {{host}}/api/me
    Authorization: Bearer {{token}}
    HTTP 200
    [Asserts]
    jsonpath "$.username" == "{{user}}"

Run: `hurl --variable host=http://localhost:3000 --variable user=bob --secret password=$PASS login.hurl`

</example>

<example description="Poll an async job until it completes">

    POST {{host}}/jobs
    HTTP 201
    [Captures]
    job_id: jsonpath "$.id"

    GET {{host}}/jobs/{{job_id}}
    [Options]
    retry: 10
    retry-interval: 500ms
    HTTP 200
    [Asserts]
    jsonpath "$.state" == "COMPLETED"

</example>

<example description="Run a suite in CI with reports">

    rm -rf build/hurl-report build/hurl-junit.xml
    hurl --test \
         --variables-file vars/staging.env \
         --error-format long \
         --report-junit build/hurl-junit.xml \
         --report-html build/hurl-report \
         tests/

</example>

<example description="Convert a curl command into a Hurl file">

    echo "curl -X POST https://api.example.org/users -H 'Content-Type: application/json' -d '{\"name\":\"bob\"}'" | hurlfmt --in curl

</example>

</examples>

## References

- [File Format](references/file-format.md) -- Entries, request/response anatomy, all sections and body types, templating, grammar gotchas
- [Asserting](references/asserting.md) -- Every query type and predicate, implicit vs explicit asserts, typing rules
- [Captures and Filters](references/captures-and-filters.md) -- Capture syntax and scope, the full filter table, chaining, secrets and redaction
- [CLI](references/cli.md) -- hurl and hurlfmt: invocation, test mode, all option groups, reports, exit codes, [Options] precedence
- [Testing Workflows](references/testing-workflows.md) -- Suite layout, retry-until polling, environments, CI integration, debugging, executable-docs export
- [Recipes](references/recipes.md) -- 30 complete runnable examples: auth flows, chained requests, uploads, GraphQL, CI snippets

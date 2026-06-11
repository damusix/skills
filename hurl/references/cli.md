# CLI Reference

Hurl 8.0.1. Two binaries: `hurl` (runs files) and `hurlfmt` (formats/converts files). `--interactive` was removed in 8.0.


## Installation

| Method | Command |
|---|---|
| Homebrew (macOS) | `brew install hurl` |
| MacPorts | `sudo port install hurl` |
| Debian/Ubuntu | `sudo apt install ./hurl_${VERSION}_amd64.deb` (deb from GitHub releases; PPA for Ubuntu >= 22.04) |
| Arch | `pacman -Sy hurl` |
| conda-forge | `conda install -c conda-forge hurl` |
| Cargo | `cargo install --locked hurl` |
| npm (dev dependency wrapper) | `npm install --save-dev @orangeopensource/hurl` |
| Windows | `winget install hurl` / `choco install hurl` / `scoop install hurl` |
| Docker | `docker pull ghcr.io/orange-opensource/hurl:latest` |
| Binaries | Prebuilt archives on GitHub releases (Linux x86_64, macOS Intel/ARM, Windows) |

The release archives ship both `hurl` and `hurlfmt`. With Docker, mount the working directory so Hurl can read files:

    docker run --rm -v "$PWD":/work -w /work ghcr.io/orange-opensource/hurl:latest --test api.hurl


## Basic invocation

    hurl [OPTIONS] [FILES...]

Input forms:

- One or more files: `hurl a.hurl b.hurl` — each file executes independently; one file's result never affects another.
- Directory argument: recursive search for `.hurl` files.
- `--glob '*.hurl'` — repeatable; supports `*`, `?`, `[]`. Quote the pattern so the shell does not expand it (cli-only).
- No input files: reads from stdin — `echo 'GET https://example.org' | hurl`.

Default output: Hurl executes every entry in the file and writes the body of the last HTTP response to stdout. JSON bodies are prettified and colorized when stdout is a terminal (`--pretty`/`--no-pretty`, `--color`/`--no-color`). Redirect with `-o, --output FILE`. Debug and progress information goes to stderr, never stdout.

Within one file, an assert failure stops the remaining entries unless `--continue-on-error` is set (cli-only).


## Test mode (--test)

    hurl --test *.hurl

What changes vs. default mode:

- Response bodies are not written to stdout.
- Per-file progress plus a text recap after all files run (executed/succeeded/failed counts, duration).
- Files run in parallel by default (default mode is sequential). Force sequential with `--jobs 1`.
- Progress bar in interactive TTYs; `--progress-bar` forces it in non-interactive TTYs (CI logs).
- Exit code is `0` only when every file succeeds; an assert failure exits `4` (see exit codes). This is what makes `--test` CI-friendly.

`--test` is cli-only (cannot appear in `[Options]`). Env var: `HURL_TEST`.


## Variables and secrets from the CLI

- `--variable NAME=VALUE` — defines a variable usable in `{{name}}` templates. Repeatable.
- `--variables-file FILE` — properties file, one `name=value` per line. Defining the same variable twice is an error (cli-only).
- Environment: `HURL_VARIABLE_name=value` defines variable `name` — e.g. `HURL_VARIABLE_host=https://staging.example.org hurl api.hurl`.
- Precedence (lowest to highest): environment variables, then CLI options, then `[Options]` section in the file.

Secrets are variables whose values are redacted from stderr logs (`--verbose`/`--very-verbose`) and from reports:

- `--secret NAME=VALUE` (cli-only; env `HURL_SECRET_name`).
- `--secrets-file FILE` — `name=value` lines; defining a secret twice is an error (cli-only).

<constraints>

- Redaction is exact-match. If a secret value gets transformed (uppercased, encoded), add each transformed value as an extra secret: `--secret token=FooBar --secret token_alt=FOOBAR`.
- Secrets are not redacted from stdout — Hurl treats stdout as the unaltered output of the run. `--include` and `--json` output is likewise unredacted, and the JSON report saves raw HTTP responses to disk. Do not ship report artifacts containing secret-bearing response bodies.

</constraints>


## Request-shaping options

Options that exist in curl have the same semantics as curl. Unless marked *(cli-only)*, these can also go in a per-request `[Options]` section. Env vars listed where they exist.

### Redirects, TLS, auth

| Option | Meaning | Env |
|---|---|---|
| `-L, --location` | Follow redirects (cap with `--max-redirs`, default 50, `-1` unlimited) | `HURL_LOCATION` |
| `--location-trusted` | Like `-L` but re-sends credentials to redirect targets (security tradeoff) | `HURL_LOCATION_TRUSTED` |
| `-k, --insecure` | Allow insecure SSL connections | `HURL_INSECURE` |
| `--cacert FILE` | CA bundle (PEM) for peer verification | — |
| `-E, --cert CERT[:PASSWORD]` / `--key KEY` | Client certificate / private key | — |
| `--pinnedpubkey HASHES` | Abort unless server public key matches | — |
| `--ssl-no-revoke` | (Windows) skip cert revocation checks *(cli-only)* | — |
| `-u, --user USER:PASSWORD` | Basic auth header on each request | `HURL_USER` |
| `--digest` / `--ntlm` / `--negotiate` | Digest / NTLM / SPNEGO auth | — |
| `--aws-sigv4 PROVIDER1[:PROVIDER2[:REGION[:SERVICE]]]` | AWS SigV4 signing; credentials via `-u` | — |
| `-n, --netrc` / `--netrc-file FILE` / `--netrc-optional` | .netrc credential lookup | — |

### Timeouts, retries, pacing

| Option | Meaning | Env |
|---|---|---|
| `--connect-timeout SECONDS` | Connection timeout; accepts units: `20s`, `35000ms` (no spaces) | `HURL_CONNECT_TIMEOUT` |
| `-m, --max-time SECONDS` | Total per-request/response timeout; same unit syntax | `HURL_MAX_TIME` |
| `--retry NUM` | Max retries; `0` none, `-1` unlimited. Retries on any error: asserts, captures, runtime | `HURL_RETRY` |
| `--retry-interval MILLISECONDS` | Wait between retries, default 1000 ms; units OK (`2s`, `500ms`) | `HURL_RETRY_INTERVAL` |
| `--delay MILLISECONDS` | Sleep before each request (not applied to retried requests); units `ms`, `s`, `m`, `h` | `HURL_DELAY` |
| `--repeat NUM` | Repeat the whole input-file sequence NUM times (`-1` infinite): `a b c a b c` | — |
| `--limit-rate SPEED` | Max transfer rate in bytes/second | `HURL_LIMIT_RATE` |

### Parallelism

| Option | Meaning | Env |
|---|---|---|
| `--parallel` | Run files in parallel, one worker thread each, sharing nothing. Default in `--test` mode; sequential otherwise *(cli-only)* | — |
| `--jobs NUM` | Max parallel workers; defaults to CPU count; `--jobs 1` disables parallelism *(cli-only)* | `HURL_JOBS` |

### Headers, cookies, body handling

| Option | Meaning | Env |
|---|---|---|
| `-H, --header NAME:VALUE` | Inject an extra header; repeatable | `HURL_HEADER='name1:value1\|name2:value2'` (separator: `\|`) |
| `-A, --user-agent NAME` | Set User-Agent *(cli-only)* | `HURL_USER_AGENT` |
| `-b, --cookie FILE` | Read cookies from Netscape-format file *(cli-only)* | — |
| `-c, --cookie-jar FILE` | Write cookies after the run (Netscape format). `-b` + `-c` simulates persistent cookie storage across runs *(cli-only)* | — |
| `--no-cookie-store` | Disable the within-file shared cookie engine *(cli-only)* | `HURL_NO_COOKIE_STORE` |
| `--compressed` | Request br/gzip/deflate and auto-decompress | `HURL_COMPRESSED` |
| `--max-filesize BYTES` | Refuse downloads larger than this *(cli-only)* | `HURL_MAX_FILESIZE` |
| `--file-root DIR` | Root for files referenced in bodies/multipart/output; default is the Hurl file's directory *(cli-only)* | — |

### Protocol and network targeting

| Option | Meaning | Env |
|---|---|---|
| `-0, --http1.0` / `--http1.1` / `--http2` / `--http3` | Force HTTP version. HTTP/2 negotiated by default on HTTPS; `--http3` falls back to earlier versions if the HTTP/3 handshake fails (HTTPS only) | `HURL_HTTP10` / `HURL_HTTP11` / `HURL_HTTP2` / `HURL_HTTP3` |
| `-4, --ipv4` / `-6, --ipv6` | Resolve names to IPv4 / IPv6 only | `HURL_IPV4` / `HURL_IPV6` |
| `-x, --proxy [PROTOCOL://]HOST[:PORT]` | Use proxy | `http_proxy` `https_proxy` `all_proxy` |
| `--no-proxy HOSTS` | Comma-separated proxy bypass list | `no_proxy` |
| `--resolve HOST:PORT:ADDR` | Pin a host:port to an address (CLI /etc/hosts) | — |
| `--connect-to HOST1:PORT1:HOST2:PORT2` | Connect to a different host:port pair; repeatable | — |
| `--unix-socket PATH` | Connect through a Unix domain socket | — |
| `--path-as-is` | Don't squash `/../` or `/./` in URL paths | — |

### Entry slicing and assert control

| Option | Meaning |
|---|---|
| `--from-entry N` / `--to-entry N` | Execute the file from/to entry N (1-based); `--to-entry` is handy to debug a session partway *(both cli-only)* |
| `--no-assert` | Ignore all asserts in the file *(cli-only, env `HURL_NO_ASSERT`)* |
| `--continue-on-error` | Keep executing entries after an assert error (per-file; files are independent anyway) *(cli-only, env `HURL_CONTINUE_ON_ERROR`)* |


## Output and reporting

All of these are cli-only except `-o, --output`.

### Verbosity and debugging (stderr)

- `-v, --verbose` — debug log on stderr: `>` data sent, `<` data received, `*` Hurl info. Alias for `--verbosity verbose`. Env `HURL_VERBOSE`.
- `--very-verbose` — adds full request and response bodies on stderr plus libcurl debug lines (`**`). Alias for `--verbosity debug`. Env `HURL_VERY_VERBOSE`.
- `--verbosity LEVEL` — `brief`, `verbose`, or `debug`. Env `HURL_VERBOSITY`.
- `--error-format short|long` — `long` logs the response body when an error occurs, so CI logs show what the server actually returned. Env `HURL_ERROR_FORMAT`.

### stdout shaping

- `-o, --output FILE` — write output to FILE instead of stdout. Inside `[Options]`, `output: -` means stdout. *(usable per-request in `[Options]`)*
- `-i, --include` — include response headers in the output.
- `--no-output` — suppress the default last-response-body output. Env `HURL_NO_OUTPUT`.
- `--json` — emit each file's result as JSON (format close to HAR) on stdout.
- `--pretty` / `--no-pretty` — force/disable JSON prettifying (default: pretty when stdout is a TTY). Env `HURL_PRETTY` / `HURL_NO_PRETTY`.
- `--color` / `--no-color` — force/disable colorized stdout+stderr (default: colored only on TTY). Env `HURL_COLOR` / `HURL_NO_COLOR` / `NO_COLOR`.
- `--progress-bar` — force the test-mode progress bar in non-interactive TTYs.
- `--curl FILE` — export each executed request as a list of curl commands to FILE.

### Reports (test artifacts)

| Option | Format |
|---|---|
| `--report-html DIR` | HTML report (browsable, per-file detail with request/response) |
| `--report-json DIR` | JSON report directory (stores raw HTTP responses on disk — see secrets caveat) |
| `--report-junit FILE` | JUnit XML, the standard CI ingest format |
| `--report-tap FILE` | TAP (Test Anything Protocol) |

<constraints>

All four report formats are cumulative: if the report already exists, new results are appended/merged. Useful for combining several `hurl --test` invocations into one report — but clean the report file/directory between CI runs or stale results accumulate.

</constraints>

Typical CI run:

    hurl --test --report-junit build/hurl-junit.xml --error-format long tests/**/*.hurl


## [Options] section vs CLI flags

- A CLI option applies to every entry of every file. An `[Options]` section inside a request applies to that entry only — with one exception: `variable` defined in `[Options]` persists for subsequent entries.
- Precedence, lowest to highest: environment variable (`HURL_*`) → CLI flag → `[Options]` section.
- Per-request keys allowed in `[Options]` (mirroring the flags): `aws-sigv4`, `cacert`, `cert`, `key`, `compressed`, `connect-timeout`, `delay`, `http1.0`/`http1.1`/`http2`/`http3`, `insecure`, `ipv4`/`ipv6`, `limit-rate`, `location`, `location-trusted`, `max-redirs`, `max-time`, `output`, `path-as-is`, `proxy`, `repeat`, `resolve`, `retry`, `retry-interval`, `skip`, `unix-socket`, `user`, `variable`, `verbose`, `very-verbose`.

<constraints>

- Options marked cli-only cannot appear in `[Options]`. The cli-only set: `--test`, `--parallel`, `--jobs`, `--glob`, `--color`/`--no-color`, `--json`, `--include`, `--no-output`, `--pretty`/`--no-pretty`, `--progress-bar`, `--curl`, `--error-format`, all `--report-*`, `--cookie`/`--cookie-jar`, `--no-cookie-store`, `--continue-on-error`, `--no-assert`, `--from-entry`/`--to-entry`, `--variables-file`, `--secret`/`--secrets-file`, `--file-root`, `--max-filesize`, `--user-agent`, `--ssl-no-revoke`.
- `skip: true` exists only in `[Options]` — no CLI equivalent; it skips that one entry.

</constraints>

Example — follow a redirect for one entry only, with a per-entry retry:

    GET https://example.org
    HTTP 301

    GET https://example.org
    [Options]
    location: true
    retry: 10
    retry-interval: 500ms
    variable: id=1234
    HTTP 200


## hurlfmt

    hurlfmt [options] [FILE...]

Formats Hurl files and converts them from/to other formats. With no FILE, reads stdin. Default output: a formatted, colorized version of the input.

| Option | Meaning |
|---|---|
| `--check` | Lint mode: exit 0 if input is already formatted, 1 otherwise. Incompatible with `--output`. Marked "not stable yet" |
| `--in FORMAT` | Input format: `hurl` or `curl` |
| `--out FORMAT` | Output format: `hurl`, `json`, or `html` |
| `-o, --output FILE` | Write to FILE instead of stdout |
| `--in-place` | Rewrite the file in place (text output only) |
| `--standalone` | With `--out html`: emit a full HTML page with CSS instead of an HTML fragment |
| `--color` / `--no-color` | Force/disable colorized output (`--color` incompatible with `--in-place`) |

Common uses:

    hurlfmt --in-place api.hurl                          # format
    hurlfmt --out json api.hurl | jq                     # structured view of entries
    echo "curl http://localhost:8000 -H 'A:B'" | hurlfmt --in curl   # curl -> Hurl

Note: curl export (Hurl to curl commands) is on the `hurl` binary (`hurl --curl FILE`), not hurlfmt; curl import is `hurlfmt --in curl`.

hurlfmt exit codes: `1` failed to parse command-line options; `2` input file parsing error.


## Exit codes (hurl)

| Code | Meaning |
|---|---|
| 0 | Success (in `--test` mode: all files passed) |
| 1 | Failed to parse command-line options |
| 2 | Input file parsing error (the `.hurl` file is malformed) |
| 3 | Runtime error (e.g. failure to connect to host) |
| 4 | Assert error (an `HTTP` status / header / `[Asserts]` check failed) |


## Sources

[^manual]: Hurl manual (canonical, verified against 8.0.1). <https://hurl.dev/docs/manual.html>
[^hurlfmt]: hurlfmt manual (8.0.1 tag). <https://github.com/Orange-OpenSource/hurl/blob/8.0.1/docs/manual/hurlfmt.md>
[^install]: Hurl docs — Installation. <https://hurl.dev/docs/installation.html>
[^request]: Hurl docs — Request (`[Options]` section). <https://hurl.dev/docs/request.html>
[^templates]: Hurl docs — Templates (secrets and redaction). <https://hurl.dev/docs/templates.html>

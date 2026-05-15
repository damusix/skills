# 91 — Docker + PostgreSQL

Single-host Docker patterns for PostgreSQL. Image variants, init scripts, volumes, healthchecks, `postgresql.conf` injection, multi-arch. For Kubernetes operators, see [`92-kubernetes-operators.md`](./92-kubernetes-operators.md).

## Table of Contents

- [When to Use This Reference](#when-to-use-this-reference)
- [Mental Model](#mental-model)
- [Decision Matrix](#decision-matrix)
- [Mechanics](#mechanics)
    - [Image Variants](#image-variants)
    - [Environment Variables](#environment-variables)
    - [Docker Secrets via `*_FILE` Variants](#docker-secrets-via-_file-variants)
    - [Init Scripts (`/docker-entrypoint-initdb.d/`)](#init-scripts-docker-entrypoint-initdbd)
    - [Volume Strategy for `$PGDATA`](#volume-strategy-for-pgdata)
    - [Healthchecks](#healthchecks)
    - [Custom `postgresql.conf` Injection](#custom-postgresqlconf-injection)
    - [Multi-Architecture](#multi-architecture)
    - [Per-Version Timeline](#per-version-timeline)
- [Recipes](#recipes)
- [Gotchas](#gotchas)
- [See Also](#see-also)
- [Sources](#sources)

## When to Use This Reference

Use when running PostgreSQL in Docker containers — local dev, CI integration tests, Compose stacks, single-host VPS deployments. **Not** for production multi-node clusters — for those, use a Kubernetes operator (see [`92-kubernetes-operators.md`](./92-kubernetes-operators.md)) or bare-metal + Patroni (see [`79-patroni.md`](./79-patroni.md)).

## Mental Model

Five rules.

1. **Official `postgres` image is canonical.** Maintained by docker-library team[^docker-library]. Two flavors: **Debian-slim** (default, `bookworm`/`trixie`, ~80MB compressed) + **Alpine** (`alpine3.22`/`alpine3.23`, ~50MB compressed, musl libc). Image tags = `{major}` (latest patch), `{major}.{minor}` (pinned), `{major}-bookworm` (Debian-explicit), `{major}-alpine3.22` (Alpine-explicit). Currently 5 majors published (14, 15, 16, 17, 18).

2. **`/docker-entrypoint-initdb.d/` runs on FIRST startup only.** Files matched as `*.sql` / `*.sql.gz` / `*.sh` execute alphabetically when `$PGDATA` is empty. Re-running the container with an existing data dir SKIPS init scripts. Schema migrations need an idempotent tool (Flyway, Liquibase, Alembic, Sqitch, etc.) — `initdb.d` is NOT a migration runner.

3. **`$PGDATA` on a named volume, NOT a bind mount.** Bind mounts hit two surfaces: (a) UID mismatch — the `postgres` container user is UID 70 (Alpine) or 999 (Debian), host directory must match or be world-writable; (b) overlayfs performance penalty on data files. Named volumes managed by Docker get proper ownership + native filesystem performance.

4. **Healthcheck = `pg_isready` not `psql -c 'SELECT 1'`.** `pg_isready` queries server status without authentication. Verbatim docs[^pg-isready]: "it is not necessary to supply correct user name, password, or database name values to obtain the server status." Exit codes: `0` accepting / `1` rejecting / `2` no response / `3` no attempt. `psql -c SELECT 1` requires auth + connection setup — adds noise + latency.

5. **For production multi-host, use a K8s operator.** Raw Docker + Compose has no failover, no automated backups, no leader election. CloudNativePG / Zalando / Crunchy operators provide all four. Docker is for **dev**, **CI**, and **single-host SaaS-on-a-VPS** style deployments only. See [`92-kubernetes-operators.md`](./92-kubernetes-operators.md).

## Decision Matrix

| Need | Use | Why |
|---|---|---|
| Local dev with persistent state | Named volume `pgdata` | Survives container restart; correct ownership |
| Throwaway CI test | `--tmpfs /var/lib/postgresql/data` or no volume | Speed; resets per-test |
| Single-host prod (low scale) | Compose + named volume + healthcheck + scheduled `pg_dump` to S3 | Simplest reproducible setup |
| Multi-host prod | Kubernetes operator | See [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) |
| Minimal image | Alpine variant (`postgres:17-alpine3.22`) | ~50MB vs ~80MB |
| Glibc dependencies (PostGIS, plpython3u, plperl) | Debian variant (`postgres:17` = bookworm) | Some C extensions ship glibc-only binaries |
| Custom extensions | Custom Dockerfile `FROM postgres:17` + install | Build once, version-control the result |
| Sensitive secrets | Docker secrets via `POSTGRES_PASSWORD_FILE` | No password in image history or process list |
| Custom `postgresql.conf` | Bind-mount config + `command: postgres -c config_file=...` | Decouple config from image |
| Multi-arch deployment | Pull official image (10 architectures supported) | amd64/arm64/ppc64le/s390x all published |
| Run as non-root | Set `--user UID:GID` after `chown -R UID:GID` of volume | UID 70 (Alpine) or 999 (Debian) default |
| Shared memory tuning | `--shm-size=1g` or `/dev/shm` mount | Postgres uses `/dev/shm`; Docker default is 64MB (too small) |

Smell signals — `docker run -e POSTGRES_PASSWORD=foo postgres` with no volume in prod (data lost on container removal); init scripts referenced as "migrations" (they run once, never again); `HEALTHCHECK psql -c 'SELECT 1'` shipped with hard-coded password.

## Mechanics

### Image Variants

The `docker-library/postgres` repository[^docker-lib-repo] publishes per-major directories (`14/`, `15/`, `16/`, `17/`, `18/`) each with subdirectories per variant. Currently published variants per major:

| Variant | Base image | Size (rough) | When to pick |
|---|---|---|---|
| `bookworm` | `debian:bookworm-slim` | ~80MB | Default; glibc-based; broad extension compat |
| `trixie` | `debian:trixie-slim` | ~80MB | Newer Debian; check extension availability |
| `alpine3.22` | `alpine:3.22` | ~50MB | Smallest; musl libc; some C extensions break |
| `alpine3.23` | `alpine:3.23` | ~50MB | Newest Alpine; verify base image stability |

Image header note[^dockerfile-17-bookworm]: "THIS DOCKERFILE IS GENERATED VIA 'apply-templates.sh' - PLEASE DO NOT EDIT IT DIRECTLY." The actual templates are `Dockerfile-debian.template` and `Dockerfile-alpine.template` — when forking, edit the templates, not the per-version Dockerfile.

Version pinning example (PG17 bookworm pins `PG_VERSION 17.9-1.pgdg12+1`, `PG_MAJOR 17`)[^dockerfile-17-bookworm] — production should pin to a specific patch tag like `postgres:17.9-bookworm`, not `postgres:17` (which moves with each patch release).

### Environment Variables

Set via `-e VAR=value` or Compose `environment:` block. Documented in the long-form README[^docker-library-readme].

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Yes (or `_FILE` or `_HOST_AUTH_METHOD=trust`) | (none) | Password for `POSTGRES_USER` |
| `POSTGRES_USER` | No | `postgres` | Superuser name; database with same name also created |
| `POSTGRES_DB` | No | Value of `POSTGRES_USER` | Initial database created on first init |
| `POSTGRES_INITDB_ARGS` | No | (empty) | Extra flags passed to `initdb` (e.g., `--data-checksums --encoding=UTF8 --locale=C`) |
| `POSTGRES_INITDB_WALDIR` | No | (none, WAL in `PGDATA`) | Path inside container for separate WAL directory |
| `POSTGRES_HOST_AUTH_METHOD` | No | `scram-sha-256` (PG14+) | Auth method for non-local connections in generated `pg_hba.conf` |
| `PGDATA` | No | `/var/lib/postgresql/data` | Override data directory location |
| `LANG` / `LC_ALL` | No | `en_US.utf8` (Debian) | Locale in shell + initdb |
| `POSTGRES_INITDB_SKIP_LOCALE` | No | unset | Skip locale initialization |
| `POSTGRES_PASSWORD_FILE` | No | (none) | Read password from file (Docker secret pattern) |
| `POSTGRES_USER_FILE` | No | (none) | Read username from file |
| `POSTGRES_DB_FILE` | No | (none) | Read DB name from file |

> [!WARNING] `POSTGRES_HOST_AUTH_METHOD=trust` disables authentication entirely
>
> Convenient for ephemeral CI containers. Catastrophic in production. Use Docker secrets via `POSTGRES_PASSWORD_FILE` instead.

### Docker Secrets via `*_FILE` Variants

The entrypoint's `file_env()` helper[^docker-entrypoint-17-bookworm] reads any variable from a file when `<VAR>_FILE` is set. Pattern:

```yaml
# compose.yaml
secrets:
    pg_password:
        file: ./secrets/pg_password.txt

services:
    db:
        image: postgres:17-bookworm
        environment:
            POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
        secrets:
            - pg_password
        volumes:
            - pgdata:/var/lib/postgresql/data

volumes:
    pgdata: {}
```

Password lives in a file not the process environment — does not show up in `docker inspect`, image history, or container env list.

### Init Scripts (`/docker-entrypoint-initdb.d/`)

Mount or COPY files into `/docker-entrypoint-initdb.d/`. The entrypoint runs them in **alphabetical order** by filename when `$PGDATA` is empty at container startup.

Supported extensions:

| Extension | Behavior |
|---|---|
| `*.sql` | Piped to `psql` |
| `*.sql.gz` | Decompressed + piped to `psql` |
| `*.sql.xz` | Decompressed + piped to `psql` |
| `*.sql.zst` | Decompressed + piped to `psql` |
| `*.sh` | Sourced if not executable, exec'd otherwise (sourced scripts can use `psql` interactively) |

Naming convention: prefix with order numbers (`00-create-roles.sh`, `01-create-schema.sql`, `02-seed-data.sql`) to control execution order.

> [!WARNING] Init scripts run ONCE on FIRST init only
>
> A second `docker run` against the same `$PGDATA` volume does NOT re-run them. They are NOT a schema-migration mechanism. Use Flyway / Liquibase / Alembic / Sqitch / Atlas / dbmate / golang-migrate / etc. (your application's migration tool) for ongoing schema changes.

Example init script combining role creation, extension install, and schema:

```bash
#!/usr/bin/env bash
# /docker-entrypoint-initdb.d/00-init.sh
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE app_user LOGIN PASSWORD 'replaceme';
    CREATE SCHEMA AUTHORIZATION app_user;
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
EOSQL
```

### Volume Strategy for `$PGDATA`

Three options. Pick #1 unless you have a specific reason.

**Option 1 (canonical): named volume**

```yaml
services:
    db:
        image: postgres:17-bookworm
        volumes:
            - pgdata:/var/lib/postgresql/data
volumes:
    pgdata: {}
```

- Docker manages ownership. Volume lives at `/var/lib/docker/volumes/<name>/_data` on host.
- Survives container removal (`docker rm`). Lost on volume removal (`docker volume rm`).
- Backup via `docker run --rm -v pgdata:/data -v $(pwd):/backup alpine tar czf /backup/pgdata.tar.gz -C /data .` or via `pg_dump` (preferred).

**Option 2 (problematic): bind mount**

```yaml
services:
    db:
        image: postgres:17-bookworm
        volumes:
            - ./pgdata:/var/lib/postgresql/data
```

- Two failure modes: (a) UID mismatch — postgres process runs as UID 999 (Debian) or 70 (Alpine), host directory must match or container will fail with `chown` errors; (b) on Mac/Windows Docker Desktop, bind mounts go through filesystem-translation layer and are 5-10× slower than named volumes.

**Option 3 (ephemeral): tmpfs**

```yaml
services:
    db:
        image: postgres:17-bookworm
        tmpfs:
            - /var/lib/postgresql/data
```

- RAM-backed; resets per container restart.
- Useful for CI integration tests where the test database is recreated per run.
- Do NOT use for any data you care about.

Run as non-root when bind-mounting:

```sh
# Prepare host dir with correct ownership
sudo chown -R 999:999 ./pgdata
docker run -d \
    --name pg17 \
    -e POSTGRES_PASSWORD=mypassword \
    --user 999:999 \
    -v $(pwd)/pgdata:/var/lib/postgresql/data \
    postgres:17-bookworm
```

### Healthchecks

`pg_isready` is the canonical tool. Verbatim from PG docs[^pg-isready]:

> "pg_isready issues a connection check to a PostgreSQL database. The exit status specifies the result of the check."

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Server is accepting connections normally |
| 1 | Server is rejecting connections (e.g., during startup or recovery) |
| 2 | No response (network unreachable, no listener) |
| 3 | No attempt was made (invalid arguments) |

Crucially[^pg-isready]: "it is not necessary to supply correct user name, password, or database name values to obtain the server status." No credentials needed.

Compose healthcheck pattern[^compose-healthcheck]:

```yaml
services:
    db:
        image: postgres:17-bookworm
        environment:
            POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
        healthcheck:
            test: ["CMD", "pg_isready", "-U", "postgres", "-d", "postgres"]
            interval: 10s
            timeout: 5s
            retries: 5
            start_period: 30s
```

Dockerfile `HEALTHCHECK` form[^docker-healthcheck]:

```dockerfile
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
    CMD pg_isready -U postgres || exit 1
```

Default Docker HEALTHCHECK params[^docker-healthcheck]: `--interval=30s`, `--timeout=30s`, `--start-period=0s`, `--start-interval=5s`, `--retries=3`. For Postgres, override `--start-period` to 30-60s — initdb + first startup takes time on slow disks.

`pg_isready` exit code 1 (rejecting connections) DURING startup is normal — the server is up but not yet accepting clients. Healthcheck retries handle this; do not interpret single failures as unhealthy.

### Custom `postgresql.conf` Injection

Three patterns.

**Pattern A — Bind-mount full config file and override `command`:**

```yaml
services:
    db:
        image: postgres:17-bookworm
        command:
            - postgres
            - -c
            - config_file=/etc/postgresql/postgresql.conf
        volumes:
            - ./postgresql.conf:/etc/postgresql/postgresql.conf:ro
            - pgdata:/var/lib/postgresql/data
```

Useful when you want a complete config under version control.

**Pattern B — `POSTGRES_INITDB_ARGS` + per-GUC `-c` flags:**

```yaml
services:
    db:
        image: postgres:17-bookworm
        environment:
            POSTGRES_INITDB_ARGS: "--data-checksums --encoding=UTF8 --locale=C.UTF-8"
        command:
            - postgres
            - -c
            - shared_buffers=512MB
            - -c
            - max_connections=200
            - -c
            - log_statement=all
```

`POSTGRES_INITDB_ARGS` controls `initdb` flags during the **first** init only[^initdb]. `-c` flags on the `postgres` command override `postgresql.conf` settings at every startup.

**Pattern C — Drop-in `conf.d` directory:**

```sh
# postgresql.conf in image's default location has:
# include_dir = 'conf.d'
```

Bind-mount your additions:

```yaml
services:
    db:
        image: postgres:17-bookworm
        volumes:
            - ./conf.d:/var/lib/postgresql/data/conf.d:ro
            - pgdata:/var/lib/postgresql/data
```

Files in `conf.d/` are loaded alphabetically. Override individual settings without replacing the whole config.

### Multi-Architecture

The official image[^docker-hub-postgres] is published for **10 architectures**: `amd64, arm32v5, arm32v6, arm32v7, arm64v8, i386, mips64le, ppc64le, riscv64, s390x`.

Pulling `postgres:17-bookworm` on an Apple Silicon Mac (arm64) gets the native arm64 image automatically. No emulation needed.

Confirm pulled image architecture:

```sh
docker inspect postgres:17-bookworm --format '{{.Architecture}}'
```

Force pull a specific architecture (rare; usually for cross-build):

```sh
docker pull --platform=linux/arm64 postgres:17-bookworm
```

> [!WARNING] Cross-architecture restore is impossible
>
> A `pg_basebackup` or `pg_dump -Fc` backup taken from an amd64 container cannot be restored into an arm64 container. Use `pg_dump` plain SQL (`-Fp`) for cross-architecture migration. Same rule applies as bare-metal: physical backup is byte-level; logical backup is portable. See [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) and [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md).

### Per-Version Timeline

Docker-relevant PG release-note items.

| Version | Items |
|---|---|
| **PG14** | `initdb --no-instructions` (suppress startup hints — cleaner container logs)[^pg14-relnotes]; `initdb --discard-caches` (test-build helper)[^pg14-relnotes]. |
| **PG15** | **No Docker-specific items.** Stated explicitly. Major release notes do not call out container-relevant features.[^pg15-relnotes] |
| **PG16** | `initdb -c name=value` (set GUCs at init time — cleaner than `POSTGRES_INITDB_ARGS` for individual GUCs)[^pg16-relnotes]; ICU built by default — `--locale-provider=icu` works without external dependency[^pg16-relnotes]. |
| **PG17** | `initdb --sync-method=syncfs` (faster on Linux when many small files); `allow_alter_system` GUC (locks down `ALTER SYSTEM` — useful in immutable-config container deployments)[^pg17-relnotes]. |
| **PG18** | **Data checksums enabled by default** at `initdb` — verbatim release note[^pg18-relnotes]: "Change `initdb` to default to enabling checksums" (Greg Sabino Mullane). New `--no-data-checksums` flag opts out. New `--no-sync-data-files` (skip fsync of data files — useful for ephemeral containers). See [`88-corruption-recovery.md`](./88-corruption-recovery.md) for `pg_upgrade` interaction. |

Every PG14-PG18 release except PG15 added container-relevant `initdb` items. PG15 stated explicitly as having zero Docker-relevant items.

## Recipes

### 1. Minimum-viable dev Compose stack with persistent state + healthcheck

```yaml
# compose.yaml
services:
    db:
        image: postgres:17.9-bookworm
        restart: unless-stopped
        environment:
            POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
            POSTGRES_DB: appdb
            POSTGRES_USER: appuser
        secrets:
            - pg_password
        volumes:
            - pgdata:/var/lib/postgresql/data
            - ./init:/docker-entrypoint-initdb.d:ro
        ports:
            - "5432:5432"
        healthcheck:
            test: ["CMD", "pg_isready", "-U", "appuser", "-d", "appdb"]
            interval: 10s
            timeout: 5s
            retries: 5
            start_period: 30s

secrets:
    pg_password:
        file: ./secrets/pg_password.txt

volumes:
    pgdata: {}
```

Files:

```
.
├── compose.yaml
├── secrets/
│   └── pg_password.txt          # chmod 0600
└── init/
    ├── 00-extensions.sh
    └── 01-schema.sql
```

### 2. Custom image with extensions baked in

```dockerfile
# Dockerfile
FROM postgres:17.9-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        postgresql-17-pgvector \
        postgresql-17-pg-stat-kcache \
        postgresql-17-cron \
    && rm -rf /var/lib/apt/lists/*

# Pre-load shared libraries in postgresql.conf
COPY postgresql.conf.snippet /etc/postgresql/conf.d/extensions.conf
```

`postgresql.conf.snippet`:

```ini
shared_preload_libraries = 'pg_stat_statements,pg_stat_kcache,pg_cron'
pg_cron.database_name = 'appdb'
```

Build + run:

```sh
docker build -t myapp/postgres:17 .
docker run -d --name pg \
    -e POSTGRES_PASSWORD_FILE=/run/secrets/pg_password \
    -v pgdata:/var/lib/postgresql/data \
    myapp/postgres:17
```

### 3. Override `postgresql.conf` via per-GUC command flags

For small tuning changes without a custom image:

```yaml
services:
    db:
        image: postgres:17-bookworm
        command:
            - postgres
            - -c
            - shared_buffers=1GB
            - -c
            - effective_cache_size=3GB
            - -c
            - work_mem=16MB
            - -c
            - max_connections=200
            - -c
            - log_min_duration_statement=500
            - -c
            - log_statement=ddl
```

### 4. Shared-memory tuning (`/dev/shm` default is too small)

```yaml
services:
    db:
        image: postgres:17-bookworm
        shm_size: 1gb
```

Or `docker run --shm-size=1g postgres:17`. Default 64MB causes `ERROR: out of shared memory` on workloads with many connections, parallel queries, or large temp files. Postgres uses `/dev/shm` for `dynamic_shared_memory_type=posix` allocations.

### 5. Disable host-machine port exposure for production

Default `ports: ["5432:5432"]` exposes the container to all host network interfaces. Bind to localhost only:

```yaml
services:
    db:
        image: postgres:17-bookworm
        ports:
            - "127.0.0.1:5432:5432"
```

Or omit `ports:` entirely and connect from other containers via the Compose network.

### 6. Audit running container's actual config

```sh
docker exec -it pg17 \
    psql -U postgres -c "SELECT name, setting, source, sourcefile, sourceline
                                             FROM pg_settings
                                             WHERE source NOT IN ('default', 'override')
                                             ORDER BY name;"
```

Shows every GUC overridden from the compiled-in default, including those set via `-c` command flags vs `postgresql.conf` vs `ALTER SYSTEM`.

### 7. Backup pattern with `pg_dump` to host

```sh
docker exec pg17 pg_dump -U postgres -Fc -d appdb > backup-$(date +%F).dump
```

Or via volume mount:

```sh
docker run --rm \
    --network=container:pg17 \
    -v $(pwd):/backup \
    postgres:17-bookworm \
    pg_dump -h db -U postgres -Fc -d appdb -f /backup/backup-$(date +%F).dump
```

For production, schedule via cron on host or use a sidecar container with `pg_dump` + `aws s3 cp`. See [`85-backup-tools.md`](./85-backup-tools.md) for production-grade tools.

### 8. CI test pattern with tmpfs (fastest possible test setup)

```yaml
# compose.test.yaml
services:
    db:
        image: postgres:17-alpine3.22
        environment:
            POSTGRES_PASSWORD: test
            POSTGRES_HOST_AUTH_METHOD: trust
        tmpfs:
            - /var/lib/postgresql/data
        healthcheck:
            test: ["CMD", "pg_isready", "-U", "postgres"]
            interval: 1s
            timeout: 2s
            retries: 30
```

Ephemeral, no volume cleanup, ~1-2s to ready. `trust` auth is fine in throwaway test containers.

### 9. Wait for healthy in shell scripts

```sh
docker compose up -d db
# Wait for healthcheck to report healthy
while [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q db)")" != "healthy" ]; do
    sleep 1
done
echo "Postgres is ready."
```

Better than `sleep 30` — works with any healthcheck-configured container.

### 10. Pin to specific patch version

```yaml
services:
    db:
        image: postgres:17.9-bookworm    # NOT just `postgres:17`
```

Production should always pin the patch version. `postgres:17` moves with each minor release and can introduce unexpected behavior changes. Audit:

```sh
docker image ls --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}}' | grep postgres
```

### 11. Run with PG18 default-on data checksums

```yaml
services:
    db:
        image: postgres:18-bookworm
        environment:
            POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
            # Default initdb behavior in PG18+: --data-checksums is default
            # Opt out with:
            # POSTGRES_INITDB_ARGS: "--no-data-checksums"
        volumes:
            - pgdata:/var/lib/postgresql/data
```

PG18 verbatim release note[^pg18-relnotes]: "Change `initdb` to default to enabling checksums" (Greg Sabino Mullane). See [`88-corruption-recovery.md`](./88-corruption-recovery.md) gotcha #11 for `pg_upgrade` interaction.

### 12. Inspect entrypoint behavior

The entrypoint[^docker-entrypoint-17-bookworm] is at `/usr/local/bin/docker-entrypoint.sh` in the image. Override for debugging:

```sh
docker run --rm -it \
    -e POSTGRES_PASSWORD=foo \
    --entrypoint bash \
    postgres:17-bookworm \
    -c 'cat /usr/local/bin/docker-entrypoint.sh | less'
```

Or inspect specific entrypoint phases via `docker logs` after the container has started.

### 13. Stop-the-line: container exits immediately

Common cause: `POSTGRES_PASSWORD` unset and no `*_FILE` or `HOST_AUTH_METHOD=trust` set. Verbatim error[^docker-library-readme]:

```
Error: Database is uninitialized and superuser password is not specified.
                You must specify POSTGRES_PASSWORD to a non-empty value for the
                superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".
```

Fix: set `POSTGRES_PASSWORD` env var, or `POSTGRES_PASSWORD_FILE=/run/secrets/...`, or `POSTGRES_HOST_AUTH_METHOD=trust` (insecure — dev only).

## Gotchas

1. **Init scripts run ONCE.** First container startup with empty `$PGDATA` only. Re-running with existing data dir SKIPS them. They are NOT a migration tool. Use Flyway / Liquibase / Alembic / Sqitch.

2. **Bind-mount UID mismatch.** Container runs as UID 999 (Debian) or 70 (Alpine). Host directory must match or be world-writable. Symptom: `initdb: error: could not change permissions of directory ...`. Fix: `chown -R 999:999 ./pgdata` before mounting.

3. **Default `/dev/shm` is 64MB — too small.** Workloads with parallel queries, many connections, or large temp files hit `ERROR: out of shared memory`. Set `shm_size: 1gb` or larger in Compose.

4. **`POSTGRES_HOST_AUTH_METHOD=trust` disables authentication.** Dev/CI only. Catastrophic in production — anyone on the container network gets superuser.

5. **`POSTGRES_PASSWORD` in `environment:` block leaks via `docker inspect`.** Use Docker secrets via `POSTGRES_PASSWORD_FILE` for anything beyond local dev.

6. **Named volume removal is destructive.** `docker volume rm pgdata` deletes the data dir. No `--force-yes-i-mean-it` prompt. Back up before removing volumes.

7. **`docker compose down -v` removes volumes.** The `-v` flag deletes named volumes. `docker compose down` alone preserves them.

8. **Alpine variant may break extensions with glibc dependencies.** PostGIS in Alpine works; some Python/Perl extensions don't. If unsure, use the Debian variant.

9. **`postgres:17` tag moves with every minor release.** Pin to `postgres:17.9-bookworm` in production. Otherwise `docker pull` weeks apart gets different patch versions silently.

10. **`pg_isready` exit code 1 (rejecting) during startup is normal.** The server is up but in recovery / not yet accepting clients. Set `start_period: 30s` in healthcheck so initial restarts don't mark the container unhealthy.

11. **`docker stop` sends SIGTERM, default 10s grace.** Postgres on SIGTERM does a "fast shutdown" — closes connections + flushes WAL. 10s usually fine but raise `--time=30` for large `shared_buffers`. SIGKILL after timeout = unclean shutdown = potential recovery on next start.

12. **`postgres:18` defaults to data-checksums on.** `pg_upgrade` from a non-checksum pre-PG18 cluster needs `--no-data-checksums` on the new initdb. See [`88-corruption-recovery.md`](./88-corruption-recovery.md) gotcha #11.

13. **Cross-architecture restore is impossible.** A `pg_basebackup` from an amd64 container cannot restore into an arm64 container. Use `pg_dump -Fp` for cross-arch migration.

14. **`PGDATA` env var override is rarely useful.** The image defaults to `/var/lib/postgresql/data`. Overriding requires also updating volume mount paths. Common source of "volume mounted but database appears empty" confusion.

15. **`docker-entrypoint-initdb.d` script exit codes matter.** `set -e` in `.sh` scripts; `\set ON_ERROR_STOP on` in `.sql` files. A silent failure leaves the database in a half-initialized state on first startup with no clear error.

16. **`POSTGRES_INITDB_ARGS` flags only apply at first init.** Adding `--data-checksums` after the database exists has no effect. Use `pg_checksums --enable` offline (see [`88-corruption-recovery.md`](./88-corruption-recovery.md)).

17. **Compose `restart: always` traps unhealthy containers in loop.** If the container crashes due to bad config, `restart: always` keeps trying. Combine with healthcheck + `restart: on-failure:3` for bounded retries.

18. **Logs go to stdout/stderr.** `docker logs pg17`. No log rotation by default — the JSON file driver fills disk over time. Use `--log-driver=local` with `--log-opt max-size=100m --log-opt max-file=5`, or rely on `log_destination=stderr` + external log shipper.

19. **`postgres:17-alpine` and `postgres:17-alpine3.22` are different tags.** Track Alpine versions explicitly — `alpine` floats, `alpine3.22` pins.

20. **No automated backup in the official image.** Zero. You add `pg_dump` cron, pgBackRest, Barman, or WAL-G as a sidecar — see [`85-backup-tools.md`](./85-backup-tools.md).

21. **Operator-level features missing.** No automatic failover, no leader election, no PITR orchestration. For multi-host prod, use a Kubernetes operator — see [`92-kubernetes-operators.md`](./92-kubernetes-operators.md).

22. **PG15 release notes name no Docker-relevant items.** Every other PG14-PG18 release added `initdb` features useful in containers. If a tutorial claims PG15 introduced a container-relevant feature, verify against the release notes directly.

23. **`POSTGRES_INITDB_WALDIR` is fragile.** Specifies a separate WAL directory via `initdb --waldir`. If the path inside the container is not on a mounted volume, WAL is lost on container removal. Always mount the WAL path as a separate volume if using this.

## See Also

- [`28-vacuum-autovacuum.md`](./28-vacuum-autovacuum.md) — autovacuum tuning carries forward into container deployments
- [`46-roles-privileges.md`](./46-roles-privileges.md) — `POSTGRES_USER` becomes a superuser; create app roles via init scripts
- [`48-authentication-pg-hba.md`](./48-authentication-pg-hba.md) — `POSTGRES_HOST_AUTH_METHOD` generates `pg_hba.conf`
- [`49-tls-ssl.md`](./49-tls-ssl.md) — TLS in containers requires mounting certs + custom postgresql.conf
- [`53-server-configuration.md`](./53-server-configuration.md) — `-c GUC=value` form mirrored in `command:` block
- [`54-memory-tuning.md`](./54-memory-tuning.md) — `shared_buffers` / `effective_cache_size` apply identically
- [`82-monitoring.md`](./82-monitoring.md) — postgres_exporter as sidecar container pattern
- [`83-backup-pg-dump.md`](./83-backup-pg-dump.md) — logical backup pattern via `docker exec pg_dump`
- [`84-backup-physical-pitr.md`](./84-backup-physical-pitr.md) — physical backup + PITR for containers
- [`85-backup-tools.md`](./85-backup-tools.md) — pgBackRest / Barman / WAL-G as sidecar containers
- [`86-pg-upgrade.md`](./86-pg-upgrade.md) — major-version upgrade in containers needs careful volume handling
- [`87-major-version-upgrade.md`](./87-major-version-upgrade.md) — upgrade strategies translate directly to containers
- [`88-corruption-recovery.md`](./88-corruption-recovery.md) — PG18 default checksums + `pg_upgrade` interaction
- [`90-disaster-recovery.md`](./90-disaster-recovery.md) — container backup/restore drill
- [`92-kubernetes-operators.md`](./92-kubernetes-operators.md) — production multi-host pattern (next file)
- [`100-pg-versions-features.md`](./100-pg-versions-features.md) — per-version `initdb` changes (checksums default-on in PG18) documented here
- [`101-managed-vs-baremetal.md`](./101-managed-vs-baremetal.md) — Docker is for self-hosted; managed services hide the container layer

## Sources

[^docker-library]: docker-library/postgres GitHub repository. https://github.com/docker-library/postgres — verbatim repo description: "Docker Official Image packaging for Postgres."

[^docker-hub-postgres]: Docker Hub `postgres` official image listing. https://hub.docker.com/_/postgres — variants `bookworm`, `trixie`, `alpine3.22`, `alpine3.23` across PG14-18; 10 architectures (`amd64, arm32v5, arm32v6, arm32v7, arm64v8, i386, mips64le, ppc64le, riscv64, s390x`).

[^docker-lib-repo]: docker-library/postgres source repo structure. https://github.com/docker-library/postgres — top-level dirs `14/`, `15/`, `16/`, `17/`, `18/` plus `Dockerfile-debian.template`, `Dockerfile-alpine.template`, `apply-templates.sh`.

[^dockerfile-17-bookworm]: PG17 bookworm Dockerfile. https://github.com/docker-library/postgres/blob/master/17/bookworm/Dockerfile — auto-generated header: "THIS DOCKERFILE IS GENERATED VIA 'apply-templates.sh' - PLEASE DO NOT EDIT IT DIRECTLY." Pins `PG_VERSION 17.9-1.pgdg12+1`, `PG_MAJOR 17`.

[^docker-entrypoint-17-bookworm]: PG17 bookworm entrypoint script. https://github.com/docker-library/postgres/blob/master/17/bookworm/docker-entrypoint.sh — implements `file_env()` for `*_FILE` Docker-secret variants, `docker_verify_minimum_env()`, `initdb`, pg_hba auth setup, and `/docker-entrypoint-initdb.d/` execution.

[^docker-library-readme]: docker-library/docs long-form README for `postgres`. https://github.com/docker-library/docs/blob/master/postgres/README.md — covers `POSTGRES_PASSWORD/USER/DB`, volumes, `/docker-entrypoint-initdb.d`, Debian vs Alpine variants, Docker Secrets, locale, arbitrary `--user`, and shared-memory tuning. Verbatim error message for missing password: "Error: Database is uninitialized and superuser password is not specified."

[^pg-isready]: PostgreSQL `pg_isready` documentation. https://www.postgresql.org/docs/16/app-pg-isready.html — exit codes `0=accepting`, `1=rejecting`, `2=no-response`, `3=no-attempt`. Verbatim: "it is not necessary to supply correct user name, password, or database name values to obtain the server status."

[^docker-healthcheck]: Docker Dockerfile HEALTHCHECK reference. https://docs.docker.com/reference/dockerfile/#healthcheck — forms `HEALTHCHECK CMD <cmd>` / `HEALTHCHECK NONE`. Defaults: `--interval=30s`, `--timeout=30s`, `--start-period=0s`, `--start-interval=5s`, `--retries=3`.

[^compose-healthcheck]: Docker Compose healthcheck reference. https://docs.docker.com/compose/compose-file/05-services/#healthcheck — keys `test` (`NONE`/`CMD`/`CMD-SHELL`), `interval`, `timeout`, `retries`, `start_period`, `start_interval`.

[^initdb]: PostgreSQL `initdb` documentation. https://www.postgresql.org/docs/16/app-initdb.html — flags `-k/--data-checksums`, `-E/--encoding`, `--locale`, `-A/--auth`, `-U/--username`, `-D/--pgdata`, `--wal-segsize`, plus `--lc-*` family.

[^pg14-relnotes]: PostgreSQL 14 release notes. https://www.postgresql.org/docs/release/14.0/ — verbatim: "Add `--no-instructions` option to suppress reporting hints on how to start the server (Magnus Hagander)." Also: `initdb --discard-caches` (test-build helper).

[^pg15-relnotes]: PostgreSQL 15 release notes. https://www.postgresql.org/docs/release/15.0/ — no Docker-specific items. Major release notes do not call out container-relevant features (WAL-logged `CREATE DATABASE` default and `pg_rewind --config-file` are infrastructure changes, not container-specific).

[^pg16-relnotes]: PostgreSQL 16 release notes. https://www.postgresql.org/docs/release/16.0/ — verbatim: "Allow `initdb` to control configuration with `-c name=value` (Andrew Dunstan)." Also: ICU built by default; `pg_upgrade` auto-inherits locale/encoding.

[^pg17-relnotes]: PostgreSQL 17 release notes. https://www.postgresql.org/docs/release/17.0/ — `initdb --sync-method=syncfs` (Nathan Bossart); `allow_alter_system` GUC (Gabriele Bartolini, Jelte Fennema-Nio).

[^pg18-relnotes]: PostgreSQL 18 release notes. https://www.postgresql.org/docs/release/18.0/ — verbatim: "Change `initdb` to default to enabling checksums (Greg Sabino Mullane). A new option, `--no-data-checksums`, disables this." Also: new `--no-sync-data-files` (skip fsync of data files, useful for ephemeral containers).

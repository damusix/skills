#!/usr/bin/env bash
set -euo pipefail

# Build first
bun run build.ts

# Package theme for Ghost upload
zip -r dist.zip . \
    -x 'node_modules/*' \
    -x 'dist.zip' \
    -x '.git/*' \
    -x '.github/*' \
    -x 'assets/src/*' \
    -x 'tmp/*' \
    -x 'scripts/*' \
    -x 'build.ts' \
    -x 'bun.lock' \
    -x 'tsconfig.json' \
    -x 'eslint.config.cjs' \
    -x 'test-screenshots.ts' \
    -x 'docker-compose.yml' \
    -x '.mcp.json' \
    -x '*.log'

echo "Created dist.zip"

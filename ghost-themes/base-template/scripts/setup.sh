#!/usr/bin/env bash
set -euo pipefail

THEME_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Setting up Ghost theme development environment..."

# Start Ghost
docker compose -f "$THEME_ROOT/docker-compose.yml" up -d

# Move dotfiles into place
mv "$THEME_ROOT/scripts/setup/mcp.json" "$THEME_ROOT/.mcp.json"
mv "$THEME_ROOT/scripts/setup/github" "$THEME_ROOT/.github"

# Assert
missing=0
for f in "$THEME_ROOT/.mcp.json" "$THEME_ROOT/.github/workflows/ci.yml" "$THEME_ROOT/.github/workflows/deploy-theme.yml"; do
    if [ ! -e "$f" ]; then
        echo "ERROR: expected file missing: $f"
        missing=1
    fi
done

if [ "$missing" -eq 1 ]; then
    echo "Setup failed — one or more files were not placed correctly."
    exit 1
fi

echo "Done. Ghost is starting at http://localhost:2368"
echo "Complete the setup wizard, then activate the 'dev-theme' in Ghost Admin → Settings → Design."

#!/bin/sh
# Curl-able installer for a compiled CLI binary published to GitHub Releases:
#
#   curl -fsSL https://raw.githubusercontent.com/myorg/my-cli/main/install.sh | sh
#
# Commit this as install.sh at the repo root. It resolves the platform, pulls
# the matching release asset, verifies its sha256 against checksums.txt, and
# installs it. Assets must be named  my-cli-<os>-<arch>  (e.g. my-cli-linux-x64)
# and a checksums.txt must be attached to the release.
#
# Placeholders:
#   myorg/my-cli  -> your GitHub repo
#   my-cli        -> your binary name + asset prefix
#
# Overrides:
#   CLI_VERSION       release tag to install (default: latest), e.g. v0.2.0
#   CLI_INSTALL_DIR   target dir (default: /usr/local/bin if writable, else
#                     $HOME/.local/bin)
set -eu

REPO="myorg/my-cli"
BIN="my-cli"

say() { printf '%s: %s\n' "$BIN" "$1"; }
err() { printf '%s: error: %s\n' "$BIN" "$1" >&2; exit 1; }

download() {
    url="$1"; dest="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$dest"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$dest" "$url"
    else
        err "need curl or wget"
    fi
}

main() {
    os="$(uname -s)"; arch="$(uname -m)"
    case "$os" in
        Darwin) os=darwin ;;
        Linux)  os=linux ;;
        *) err "unsupported OS '$os' — download my-cli-windows-x64.exe from https://github.com/$REPO/releases/latest" ;;
    esac
    case "$arch" in
        arm64|aarch64) arch=arm64 ;;
        x86_64|amd64)  arch=x64 ;;
        *) err "unsupported architecture '$arch'" ;;
    esac

    asset="${BIN}-${os}-${arch}"
    version="${CLI_VERSION:-latest}"
    if [ "$version" = latest ]; then
        base="https://github.com/$REPO/releases/latest/download"
    else
        base="https://github.com/$REPO/releases/download/$version"
    fi

    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT INT TERM

    say "downloading $asset ($version)"
    download "$base/$asset" "$work/$BIN" \
        || err "download failed — does release '$version' have binaries attached?"

    # Verify checksum before installing. Fail closed on mismatch; only skip if
    # checksums.txt is genuinely absent from the release.
    if download "$base/checksums.txt" "$work/checksums.txt" 2>/dev/null; then
        expected="$(awk -v a="$asset" '$2 == a { print $1 }' "$work/checksums.txt" | head -n1)"
        if [ -n "$expected" ]; then
            if command -v shasum >/dev/null 2>&1; then
                actual="$(shasum -a 256 "$work/$BIN" | awk '{ print $1 }')"
            else
                actual="$(sha256sum "$work/$BIN" | awk '{ print $1 }')"
            fi
            [ "$expected" = "$actual" ] || err "checksum mismatch for $asset"
            say "checksum verified"
        fi
    else
        say "checksums.txt unavailable — skipping verification"
    fi

    dir="${CLI_INSTALL_DIR:-}"
    if [ -z "$dir" ]; then
        if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
            dir="/usr/local/bin"
        else
            dir="$HOME/.local/bin"
        fi
    fi
    mkdir -p "$dir" || err "cannot create install dir: $dir"

    chmod +x "$work/$BIN"
    mv "$work/$BIN" "$dir/$BIN" || err "could not install to $dir (try CLI_INSTALL_DIR=\$HOME/.local/bin or sudo)"
    say "installed to $dir/$BIN"

    case ":$PATH:" in
        *":$dir:"*) ;;
        *) say "note: $dir is not on PATH — add it: export PATH=\"$dir:\$PATH\"" ;;
    esac
}

main "$@"

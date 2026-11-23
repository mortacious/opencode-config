#!/usr/bin/env bash
# Ensure the GitHub CLI (gh) is available for PR workflows and the optional
# harness-skill hook. Dependency-free (bash + curl/tar/sha256sum/find).
#
# Non-fatal by design: every failure path prints a WARNING and exits 0, so
# install.sh keeps going.
#
# Strategy: reuse an existing gh when it is on PATH. Otherwise install the
# official release tarball into ${GH_INSTALL_DIR:-$HOME/.local/bin} (checked
# against the published checksums) - no sudo.
#
# NOTE: ~/.local/bin precedes the distro bin dirs on a typical PATH here, so a
# user-local gh SHADOWS a distro package (e.g. `pacman -S github-cli`). Remove
# $GH_INSTALL_DIR/gh to fall back to the distro binary.
#
# Optional: GH_SKILLS holds the full `owner/repo [skill]` argument list for the
# preview `gh skill install`; when set (and gh is authenticated) this installs
# those harness skills for opencode at user scope. Requires `gh auth login`.
# No skill is installed by default.
set -euo pipefail

GH_INSTALL_DIR="${GH_INSTALL_DIR:-$HOME/.local/bin}"
GH_DOC_URL="https://cli.github.com"

warn() {
  echo "WARNING: $*" >&2
}

# Install GH_SKILLS via the preview `gh skill` command. $1 is the gh binary.
# Skips with a note when the command is unavailable or gh is unauthenticated.
install_skills() {
  local gh_bin="$1"
  if [ -z "${GH_SKILLS:-}" ]; then
    return 0
  fi
  if ! "$gh_bin" skill --help >/dev/null 2>&1; then
    echo "NOTE: this gh build has no 'gh skill' command (preview); skipping GH_SKILLS." >&2
    return 0
  fi
  if ! "$gh_bin" auth status >/dev/null 2>&1; then
    echo "NOTE: gh is not authenticated; run 'gh auth login' and re-run to install GH_SKILLS." >&2
    return 0
  fi
  echo "Installing harness skills via gh skill: $GH_SKILLS"
  # GH_SKILLS is intentionally word-split: it carries the full argument list.
  # shellcheck disable=SC2086
  if ! "$gh_bin" skill install $GH_SKILLS --agent opencode --scope user; then
    echo "WARNING: 'gh skill install' failed; continuing." >&2
  fi
  return 0
}

fail() {
  warn "$*"
  echo "  Install the GitHub CLI manually: $GH_DOC_URL" >&2
  exit 0
}

# --- existing gh wins ---
if command -v gh >/dev/null 2>&1; then
  echo "gh found: $(gh --version 2>/dev/null | head -n1)"
  install_skills "$(command -v gh)"
  exit 0
fi

# --- user-local install ---
for tool in curl tar sha256sum find; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "$tool is missing; cannot auto-install gh."
  fi
done

case "$(uname -m)" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) fail "unsupported architecture $(uname -m) for gh; skipping." ;;
esac

# Resolve the latest release tag from the releases/latest redirect (no JSON).
tag="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
  https://github.com/cli/cli/releases/latest 2>/dev/null \
  | sed -E 's|.*/||' || true)"
if [ -z "$tag" ] || [ "$tag" = "latest" ]; then
  fail "could not resolve the latest gh release tag (network?)."
fi
version="${tag#v}"

asset="gh_${version}_linux_${arch}.tar.gz"
checksums="gh_${version}_checksums.txt"
base_url="https://github.com/cli/cli/releases/download/${tag}"

echo "Downloading gh ${version} (linux/${arch}) ..."
tmp="$(mktemp -d)"
if ! curl -fsSL -o "$tmp/$asset" "$base_url/$asset"; then
  rm -rf "$tmp"
  fail "download failed for $base_url/$asset."
fi
if ! curl -fsSL -o "$tmp/$checksums" "$base_url/$checksums"; then
  rm -rf "$tmp"
  fail "download failed for $base_url/$checksums."
fi

if ! ( cd "$tmp" && grep " ${asset}\$" "$checksums" | sha256sum -c - ); then
  rm -rf "$tmp"
  fail "checksum verification failed for $asset."
fi
echo "OK: checksum verified for $asset."

if ! tar -xzf "$tmp/$asset" -C "$tmp"; then
  rm -rf "$tmp"
  fail "extract failed for $asset."
fi
src_bin="$(find "$tmp" -type f -path '*/bin/gh' 2>/dev/null | head -n1 || true)"
if [ -z "$src_bin" ]; then
  rm -rf "$tmp"
  fail "archive did not contain a bin/gh binary."
fi

if ! mkdir -p "$GH_INSTALL_DIR"; then
  rm -rf "$tmp"
  fail "cannot create $GH_INSTALL_DIR."
fi
if ! cp "$src_bin" "$GH_INSTALL_DIR/gh"; then
  rm -rf "$tmp"
  fail "cannot write $GH_INSTALL_DIR/gh."
fi
chmod +x "$GH_INSTALL_DIR/gh"
rm -rf "$tmp"

if ! "$GH_INSTALL_DIR/gh" --version >/dev/null 2>&1; then
  fail "$GH_INSTALL_DIR/gh does not run on this machine."
fi
echo "OK: gh ${version} installed at $GH_INSTALL_DIR/gh (shadows a distro package on PATH)."
"$GH_INSTALL_DIR/gh" --version | head -n1

install_skills "$GH_INSTALL_DIR/gh"
exit 0

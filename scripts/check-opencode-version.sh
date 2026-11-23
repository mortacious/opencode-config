#!/usr/bin/env bash
# Enforce the minimum opencode version this configuration is built for.
#
# The context plugin pinned in opencode.jsonc (opencode-dcp@2.0.5) targets the
# opencode 2.3 API line, so older releases are unsupported. Exit 0 when the
# installed opencode is >= MIN, exit 1 otherwise (with an actionable message).
#
# Usage: check-opencode-version.sh [--quiet]
#   --quiet  suppress the success line (used inside install.sh).
set -euo pipefail

MIN="2.3.0"
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    *)
      echo "usage: check-opencode-version.sh [--quiet]" >&2
      exit 2
      ;;
  esac
done

if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode not found: this configuration requires opencode >= 2.3.0" >&2
  exit 1
fi

# First v?X.Y.Z token in the version output (leading "v" stripped).
raw="$(opencode --version 2>/dev/null || true)"
version="$(printf '%s\n' "$raw" | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -n1 | sed 's/^v//' || true)"
if [ -z "$version" ]; then
  echo "ERROR: could not parse an X.Y.Z version from 'opencode --version'." >&2
  echo "  Observed output: $raw" >&2
  echo "  This configuration requires opencode >= 2.3.0." >&2
  exit 1
fi

IFS=. read -r cur_major cur_minor cur_patch <<< "$version"
IFS=. read -r min_major min_minor min_patch <<< "$MIN"

# Numeric tuple compare (10# so a leading zero is not read as octal).
ok=1
if (( 10#$cur_major < 10#$min_major )); then
  ok=0
elif (( 10#$cur_major == 10#$min_major )); then
  if (( 10#$cur_minor < 10#$min_minor )); then
    ok=0
  elif (( 10#$cur_minor == 10#$min_minor )); then
    if (( 10#$cur_patch < 10#$min_patch )); then
      ok=0
    fi
  fi
fi

if [ "$ok" -eq 1 ]; then
  if [ "$QUIET" -eq 0 ]; then
    echo "opencode $version (>= $MIN): OK"
  fi
  exit 0
fi

echo "ERROR: opencode $version is too old: this configuration requires opencode >= $MIN." >&2
echo "  The context plugin opencode-dcp@2.0.5 targets the opencode 2.3 API line." >&2
echo "  Upgrade opencode (e.g. 'npm i -g opencode-ai@latest', or your package manager)," >&2
echo "  then re-run this check or ./install.sh." >&2
echo "  Escape hatch (unsupported): SKIP_OPENCODE_VERSION_CHECK=1 ./install.sh" >&2
exit 1

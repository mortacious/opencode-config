#!/usr/bin/env bash
# Kernel/debugger runtime prerequisites for the kernel plugin (plugin-src/kernel).
#
# Checks, one ok/warn/"- missing" line each:
#   1. kernel interpreter - the selected Python has ipykernel (hard fail if none)
#   2. host client      - the selected kernel interpreter has jupyter_client
#                         (plus KERNEL_HOST_PYTHON when it is set: the optional
#                         host for named kernelspecs)
#   3. node             - Node.js >= 22
#   4. npx              - present
#   5. debugpy          - importable in the selected kernel interpreter (warn)
#   6. ptrace           - yama ptrace_scope is 0 for C++ PID attach (warn)
#   7. mcp-debugger     - @debugmcp/mcp-debugger doctor runs (warn)
#
# This script never installs anything, never uses sudo, never starts a kernel or
# an MCP server, and never writes inside the repository. `npx` may populate its
# own cache under ~/.npm.
#
# Usage: check-runtime.sh [--python PATH] [--quiet]
#   --python PATH  kernel interpreter to check (authoritative: other candidates
#                  are not probed)
#   --quiet        suppress success lines (warnings and failures still print)
#   --help         show this usage
#
# Exit 0 when a kernel interpreter (with jupyter_client), Node >= 22, and npx
# pass (warnings do not fail). Exit 1 on a hard failure. Exit 2 on bad usage.
set -euo pipefail

KERNEL_PY=""
QUIET=0

usage() {
  cat <<'USAGE'
usage: check-runtime.sh [--python PATH] [--quiet]

Checks the kernel/debugger runtime prerequisites for the kernel plugin.

  --python PATH  kernel interpreter to check (authoritative; skips probing
                 KERNEL_PYTHON, $VIRTUAL_ENV, $CONDA_PREFIX, and python3)
  --quiet        suppress success lines (warnings and failures still print)
  --help         show this usage

Interpreter selection: --python, else KERNEL_PYTHON, else
$VIRTUAL_ENV/bin/python, else $CONDA_PREFIX/bin/python, else python3. The first
candidate that imports ipykernel is the selected kernel interpreter, and it is
also the host client (it must import jupyter_client, which ipykernel provides).

Environment:
  KERNEL_PYTHON       kernel interpreter candidate (needs ipykernel)
  KERNEL_HOST_PYTHON  optional host override for named kernelspecs; when set it
                      must import jupyter_client (independent of --python)

Read-only: installs nothing, uses no sudo, starts no kernel or MCP server.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --python)
      if [ "$#" -lt 2 ]; then
        echo "error: --python requires a path" >&2
        usage >&2
        exit 2
      fi
      KERNEL_PY="$2"
      shift 2
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

FAIL=0

ok() {
  if [ "$QUIET" -eq 0 ]; then
    echo "ok: $*"
  fi
}

warn() {
  echo "warn: $*" >&2
}

missing() {
  echo "- missing $*"
}

# have_py PATH - PATH resolves to an executable (a bare name via PATH lookup).
have_py() {
  [ -n "$1" ] && command -v "$1" >/dev/null 2>&1
}

# probe PATH MODULE - `<PATH> -c "import <MODULE>"` exits 0.
probe() {
  "$1" -c "import $2" >/dev/null 2>&1
}

# py_version PATH - the interpreter's Python version (empty when unreadable).
py_version() {
  "$1" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || true
}

# is_conda PATH - the interpreter lives in a conda env.
is_conda() {
  case "$1" in
    *conda*|*mamba*|*miniforge*) return 0 ;;
  esac
  return 1
}

# missing_ipykernel PATH - print the failure plus the install hint.
missing_ipykernel() {
  if is_conda "$1"; then
    missing "$1 lacks ipykernel. Install it: conda install ipykernel"
  else
    missing "$1 lacks ipykernel. Install it: $1 -m pip install ipykernel"
  fi
}

# same_py A B - A and B resolve to the same interpreter file.
same_py() {
  [ "$1" = "$2" ] && return 0
  A_REAL="$(command -v "$1" 2>/dev/null || echo "$1")"
  B_REAL="$(command -v "$2" 2>/dev/null || echo "$2")"
  [ "$A_REAL" = "$B_REAL" ]
}

# --- 1. kernel interpreter (ipykernel) ---
KERNEL_SELECTED=""
KERNEL_NOTE=""
if [ -n "$KERNEL_PY" ]; then
  if ! have_py "$KERNEL_PY"; then
    missing "kernel interpreter: $KERNEL_PY not found (--python)"
    echo "  Pass an existing interpreter or install ipykernel into it." >&2
    FAIL=1
  elif probe "$KERNEL_PY" ipykernel; then
    KERNEL_SELECTED="$KERNEL_PY"
    KERNEL_NOTE="--python"
  else
    missing_ipykernel "$KERNEL_PY"
    echo "  Or point --python at an env that has ipykernel." >&2
    FAIL=1
  fi
else
  candidates=()
  if [ -n "${KERNEL_PYTHON:-}" ]; then
    candidates+=("$KERNEL_PYTHON")
  fi
  if [ -n "${VIRTUAL_ENV:-}" ]; then
    candidates+=("$VIRTUAL_ENV/bin/python")
  fi
  if [ -n "${CONDA_PREFIX:-}" ]; then
    candidates+=("$CONDA_PREFIX/bin/python")
  fi
  candidates+=("python3")

  # Probe in order; the first interpreter with ipykernel wins.
  checked=()
  seen=""
  for py in "${candidates[@]}"; do
    case " $seen " in
      *" $py "*) continue ;;
    esac
    seen="$seen $py"
    if ! have_py "$py"; then
      continue
    fi
    checked+=("$py")
    if probe "$py" ipykernel; then
      KERNEL_SELECTED="$py"
      break
    fi
  done

  if [ -n "$KERNEL_SELECTED" ]; then
    KERNEL_NOTE="auto-probed"
  elif [ "${#checked[@]}" -eq 0 ]; then
    missing "kernel interpreter: no Python candidate found (KERNEL_PYTHON, \$VIRTUAL_ENV/bin/python, \$CONDA_PREFIX/bin/python, python3)"
    echo "  Install ipykernel in your kernel env, or pass --python <env>/bin/python." >&2
    FAIL=1
  else
    for py in "${checked[@]}"; do
      missing_ipykernel "$py"
    done
    echo "  Install ipykernel in the env you want as the kernel, or pass --python <env>/bin/python." >&2
    FAIL=1
  fi
fi

if [ -n "$KERNEL_SELECTED" ]; then
  KERNEL_VERSION="$(py_version "$KERNEL_SELECTED")"
  if [ -n "$KERNEL_VERSION" ]; then
    ok "kernel interpreter: $KERNEL_SELECTED (Python $KERNEL_VERSION) has ipykernel [$KERNEL_NOTE]"
  else
    ok "kernel interpreter: $KERNEL_SELECTED has ipykernel [$KERNEL_NOTE]"
  fi
fi

# --- 2. host client (jupyter_client) ---
# The selected kernel interpreter is the host client: ipykernel depends on
# jupyter_client, so a kernel that imports ipykernel normally has it too. The
# system python3 is NOT required to have it.
if [ -n "$KERNEL_SELECTED" ] && ! probe "$KERNEL_SELECTED" jupyter_client; then
  missing "$KERNEL_SELECTED lacks jupyter_client. Install it: $KERNEL_SELECTED -m pip install jupyter_client"
  FAIL=1
elif [ -n "$KERNEL_SELECTED" ]; then
  ok "host client: $KERNEL_SELECTED has jupyter_client (selected kernel interpreter)"
fi

# Optional host override for named kernelspecs.
HOST_OVERRIDE="${KERNEL_HOST_PYTHON:-}"
if [ -n "$HOST_OVERRIDE" ]; then
  if ! have_py "$HOST_OVERRIDE"; then
    missing "host client: KERNEL_HOST_PYTHON=$HOST_OVERRIDE not found (optional host for named kernelspecs)"
    FAIL=1
  elif [ -n "$KERNEL_SELECTED" ] && same_py "$HOST_OVERRIDE" "$KERNEL_SELECTED"; then
    ok "host client override: KERNEL_HOST_PYTHON is the selected kernel interpreter"
  elif probe "$HOST_OVERRIDE" jupyter_client; then
    ok "host client override: $HOST_OVERRIDE has jupyter_client (named kernelspecs)"
  else
    missing "$HOST_OVERRIDE lacks jupyter_client. Install it: $HOST_OVERRIDE -m pip install jupyter_client"
    echo "  KERNEL_HOST_PYTHON is the optional host for named kernelspecs; unset it to use the selected kernel interpreter." >&2
    FAIL=1
  fi
fi

# --- 3. node (v22+) ---
if ! command -v node >/dev/null 2>&1; then
  missing "node: not on PATH (Node.js 22+ is required)"
  FAIL=1
else
  NODE_RAW="$(node -v 2>/dev/null || true)"
  NODE_MAJOR="${NODE_RAW#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -eq "$NODE_MAJOR" ] 2>/dev/null \
      && [ "$NODE_MAJOR" -ge 22 ]; then
    ok "node: $NODE_RAW (>= v22)"
  else
    missing "node $NODE_RAW is too old: Node.js 22+ is required"
    FAIL=1
  fi
fi

# --- 4. npx ---
if command -v npx >/dev/null 2>&1; then
  ok "npx: found at $(command -v npx)"
else
  missing "npx: not on PATH (ships with npm; install Node.js 22+ with npm)"
  FAIL=1
fi

# --- 5. debugpy in the selected kernel interpreter (warn only) ---
if [ -n "$KERNEL_SELECTED" ]; then
  if probe "$KERNEL_SELECTED" debugpy; then
    ok "debugpy: available in $KERNEL_SELECTED"
  else
    warn "Python debugging needs debugpy; ipykernel normally provides it (missing in $KERNEL_SELECTED)"
  fi
fi

# --- 6. ptrace (warn only; yama absent means no restriction) ---
if [ -f /proc/sys/kernel/yama/ptrace_scope ]; then
  PTRACE_SCOPE="$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo unknown)"
  if [ "$PTRACE_SCOPE" = "0" ]; then
    ok "ptrace: ptrace_scope=0 (C++ PID attach allowed)"
  else
    warn "C++ PID attach needs ptrace_scope=0 (found ptrace_scope=$PTRACE_SCOPE): sudo sysctl kernel.yama.ptrace_scope=0"
  fi
fi

# --- 7. mcp-debugger doctor (warn only; a CLI, not a server) ---
if command -v npx >/dev/null 2>&1; then
  DOCTOR_RC=0
  if command -v timeout >/dev/null 2>&1; then
    timeout 120 npx -y @debugmcp/mcp-debugger@0.26.0 doctor >/dev/null 2>&1 || DOCTOR_RC=$?
  else
    npx -y @debugmcp/mcp-debugger@0.26.0 doctor >/dev/null 2>&1 || DOCTOR_RC=$?
  fi
  if [ "$DOCTOR_RC" -eq 0 ]; then
    ok "mcp-debugger: @debugmcp/mcp-debugger@0.26.0 doctor exited 0"
  elif [ "$DOCTOR_RC" -eq 124 ]; then
    warn "mcp-debugger doctor timed out after 120s; skipped (debugging still uses the bundled adapters)"
  else
    warn "mcp-debugger doctor failed (exit $DOCTOR_RC); run 'npx -y @debugmcp/mcp-debugger@0.26.0 doctor' for details"
  fi
fi

# --- verdict ---
if [ "$FAIL" -ne 0 ]; then
  echo "kernel/debugger runtime check FAILED: install the missing prerequisites above and re-run." >&2
  exit 1
fi

if [ "$QUIET" -eq 0 ]; then
  if [ -n "$KERNEL_SELECTED" ]; then
    echo "kernel/debugger runtime check passed (kernel interpreter: $KERNEL_SELECTED)."
  else
    echo "kernel/debugger runtime check passed."
  fi
fi
exit 0

---
name: debugging
description: Use when a runtime failure, hang, or wrong value cannot be reached by print statements - Python scripts, failing tests, ROS 2 nodes, native/C++ pipelines, or a process you must inspect live - through the debugger MCP server (launch, attach, breakpoints, snapshots, stepping, logpoints). Do not use it for simple logic errors that a test or a print already settles.
---

# Debugging

## Overview

The `debugger` MCP server (`@debugmcp/mcp-debugger`, configured in `opencode.jsonc`) drives real
step-through debuggers over DAP as MCP tools. You get breakpoints, the stack, locals, an
expression evaluator, and - most of the time - the answer without asking: every paused response
already carries a snapshot.

## When to Use

- A runtime exception whose cause is not obvious from the traceback.
- A failing test: `testRunner: "pytest"` stops at the failing assert with the exception.
- A hang or a wrong value inside a loop or library call - something you can stop on.
- A ROS 2 node or service that fails only under a live launch.
- A native or C++ pipeline where print debugging would need a rebuild.
- State you cannot reach by printing: an object's internals at a specific line.

Not for simple logic errors - read the code, write a test, or use `kernel` for quick Python
checks. Not for a crash where the stack alone answers it.

## Tool Groups

- **Session lifecycle:** `create_debug_session`, `list_debug_sessions`,
  `list_supported_languages`, `list_threads`, `close_debug_session`, `restart_debugging`.
- **Breakpoints:** `set_breakpoint`, `list_breakpoints`, `remove_breakpoint`,
  `clear_breakpoints`.
- **Execution:** `start_debugging`, `continue_execution`, `step_over`, `step_into`, `step_out`,
  `pause_execution`, `wait_for_stop`, `attach_to_process`, `detach_from_process`.
- **Inspection:** `get_stack_trace`, `get_scopes`, `get_variables`, `get_local_variables`,
  `evaluate_expression`, `get_source_context`.
- **Output and access:** `get_output`, `hot_reload`, `expose_session`, `unexpose_session`.

## Golden Path

1. `create_debug_session({language: "python", name: "<label>", executablePath: "<env>/bin/python"})`.
2. `set_breakpoint({sessionId, file: "<ABSOLUTE path>", statement: "<line text>"})`.
3. `start_debugging({sessionId, scriptPath: "<ABSOLUTE path>"})`. It answers paused if a
   breakpoint is hit as the program starts; otherwise it answers `pending:true` - call
   `wait_for_stop`.
4. Read the paused answer's `snapshot` (see below). Only then call more tools.
5. `step_over` / `step_into` / `step_out`, or `continue_execution` followed by `wait_for_stop`.
6. `get_output` for the debuggee's buffered output.
7. `close_debug_session` - always, even after a failure.

Use absolute paths throughout. Relative paths resolve against the target's filesystem, not
yours.

## Reading a Stopped Session

Every paused answer - from `start_debugging`, `restart_debugging`, `wait_for_stop`,
`pause_execution`, `attach_to_process`, and each `step_*` - carries:

```
snapshot: {exception?, frames, locals | changedVariables, truncation?}
```

That is the exception message, the top frames, and the top frame's locals, redacted and capped.
Read it before making any other call. Reach for `get_stack_trace`, `get_local_variables`, or
`get_scopes` only to expand structures, see deeper frames, or fetch a full list;
`snapshot.truncation` says when there is more.

- A repeated stop in the same frame (stepping, or a continue+wait loop over one breakpoint)
  carries `changedVariables: {name: {before, after}}` instead of `locals`. `{}` means the line
  changed nothing visible.
- An entry stop carries no snapshot.
- The stop reason on each pause says why it stopped.

Stepping, evaluation, and variable reads require the session to be `paused`. A call against a
running session fails rather than guessing.

## Breakpoints

- Prefer `statement:` over line numbers. It matches like an edit: a whole line or a distinctive
  substring, whitespace-trimmed, trailing comments ignored, exact matches winning. It only lands
  on a line containing your text; inexact or multi-candidate matches are flagged in the
  response warning, and every occurrence is listed (disambiguate with `nearLine`). It
  re-resolves across `restart_debugging`, so it survives an edit.
- `function: "<name>"` breaks on entry to a symbol with no file or line at all - the form that
  survives edits best. Python, Go, Rust, .NET, Java, and JavaScript support it.
- `expectedContent` catches off-by-one line numbers before they cost you a session: pass the
  target line's text or a distinctive substring, and a mismatch fails fast showing the real
  nearby lines.
- A response saying "requested line N, bound to line M" means the adapter moved your breakpoint.
  Trust the bound line.
- A breakpoint may report unverified until its module or class loads. That is normal.
  `list_breakpoints` shows each one's state.
- `remove_breakpoint` (by id, or file+line) and `clear_breakpoints` take effect immediately,
  even mid-run - use them to move a bisection window without restarting.

## Logpoints

`set_breakpoint` with `logMessage: "order={orderId}"` logs the interpolated message to
`get_output` without pausing - the safe way to watch values on a hot path. Python, JS, Go, and
Rust support it; Java and .NET do not.

## Output Cursor

`get_output` returns buffered debuggee stdout/stderr with a cursor. Pass the returned `nextSince`
back as `since` to read only new output. `restart_debugging` resets the buffer, so read from
`since: 0` afterwards.

## Python Launch

`executablePath` must be the environment's own interpreter: the adapter resolves `debugpy` from
that interpreter, not from the system Python. `ipykernel` installs `debugpy`, so a kernel env
usually has it. Then the golden path above, closing with `close_debug_session`.

## Failing Tests

`start_debugging({sessionId, scriptPath: "<ABSOLUTE test file>", testRunner: "pytest",
testTarget: "test_name"})` needs no breakpoint. A failing test answers paused at the failing
assert - or at the raise site of an exception escaping the test - with `snapshot.exception`,
frames, and locals. A passing test runs to completion with exit code 0.
`list_supported_languages` lists the test runners per language.

## C and C++

1. Compile with symbols and no optimization: `g++ -g -O0 -o prog prog.cpp`. Without `-g` there
   are no lines to break on.
2. `create_debug_session({language: "cpp", name: "<label>"})` - no `executablePath`.
3. `set_breakpoint` by absolute `file` + `line`, or by `statement:` with the source text. Then
   `start_debugging({scriptPath: "<ABSOLUTE path to the binary>"})`.
4. `get_stack_trace` hides adapter and runtime internals by default and reports `hiddenFrames`.
   Pass `includeInternals:true` when the interesting frame lives inside one, for example inside
   libstdc++ or the ROS client library.

## Attach to a Running Process

Attach works with a Python target started as
`python -m debugpy --listen 127.0.0.1:5678 --wait-for-client script.py`, with a JDWP-listening
JVM, and with `rdbg --open` for Ruby. Confirm the port is listening (`ss -ltn`), then
`attach_to_process({sessionId, host: "127.0.0.1", port: 5678})`. The adapter verifies the target
by polling for threads and fails the attach if none appear within `verifyTimeout` (~20 s).

- Breakpoint paths resolve on the **target's** filesystem: use debuggee-side paths, `function:`
  breakpoints, or a mapping (Python `adapterConfig.pathMappings`, Ruby `localfsMap`). The same
  applies to pods reached by port-forward.
- Attach pauses the target by default. Pass `stopOnEntry:false` when attaching to a live
  service.
- If the post-attach pause is accepted but no stop arrives in time, the answer is `running` with
  `pending:true`; call `wait_for_stop`.
- A target that exits during the handshake fails with "Debug target ended during attach". Use a
  long-running service or a `--wait-for-client` target that does not immediately exit.
- `detach_from_process` leaves the target running; you can attach again later.

C++ PID attach: `attach_to_process({sessionId, processId})` requires
`kernel.yama.ptrace_scope=0` (`sudo sysctl -w kernel.yama.ptrace_scope=0`). It is blocked by
default on a stock kernel because ptrace_scope 1 only permits tracing descendants. Launch-mode
C++ debugging is unaffected - the debuggee is a child. Do not change a host's ptrace policy
without the user's explicit approval.

## Restarting

`restart_debugging({sessionId})` relaunches with the same config in one call: breakpoints
re-apply automatically, the output buffer resets, and it works after the program exits. It is
not for attach sessions.

## IDE Mirror

`expose_session({sessionId})` returns host/port/token for a read-only IDE mirror (VS Code
`launch.json`: `"debugServer": port`, `"mirrorToken": token`). Relay these to the user;
`unexpose_session` when done. The IDE observes - execution control stays with the agent.

## Exceptions and Redaction

- Launch sessions pause at uncaught exceptions by default (`breakOnExceptions: "uncaught"`).
  Pass `"none"` to let a crashing script run to termination; attach applies no default.
- Credential-shaped values (API keys, tokens, private keys) and sensitive variable names render
  as `<redacted:rule-id>` in variables, evaluate, and output results. Only the display is
  masked - the program's state is unchanged. A `redaction` field reports what was masked, and
  the user can disable it by restarting the server with `DEBUG_MCP_NO_REDACT=1`.

## Limitations

- `get_output` reflects what the adapter buffers. A program's own stdout usually appears, but a
  process started outside the debugger, or a C++ binary whose output the adapter does not
  forward, may show nothing. When lines are missing, use the terminal or a log file.
- `expectedContent` is strict, as above. `statement:` is the robust form.
- C++ internal frames are hidden by default; `includeInternals:true` reveals them.
- PID attach needs ptrace permission; Python TCP attach does not.
- Breakpoint lines move when an adapter binds differently; trust the bound line it reports.

## Cleanup

Close every session (`close_debug_session`) and kill any target you started, including a detached
one. No leftover debuggee may keep running after the task - a detached target is still your
responsibility. Check with `list_debug_sessions` before reporting done.

## Server Command

The config entry is:

```
npx -y @debugmcp/mcp-debugger@0.26.0 stdio --log-level error
```

The `stdio` subcommand is mandatory - a bare `npx` invocation is not the server entrypoint.
`--log-level error` keeps adapter noise out of the logs.

## Common Mistakes

- Calling `get_stack_trace`, `get_scopes`, and `get_local_variables` reflexively when the paused
  answer's `snapshot` already had the frames and locals.
- Stepping or evaluating against a running session instead of waiting for a pause.
- Treating `pending:true` as a failure, or cancelling - nothing is cancelled and breakpoints
  stay armed. Call `wait_for_stop` again if it times out.
- Pointing `executablePath` at the system Python when the venv holds the modules; the adapter
  fails to find `debugpy`.
- Using relative paths for `file` or `scriptPath`.
- Setting a breakpoint on a guessed line number instead of `statement:`.
- Polling `list_debug_sessions` instead of calling `wait_for_stop`.
- Debugging an optimized C++ build where lines and variables were folded away.
- Leaving the session open or the detached target running.
- Assuming PID attach works out of the box, or changing ptrace policy without approval.
- Reading `get_output` from the start every time instead of passing `nextSince` as `since`.

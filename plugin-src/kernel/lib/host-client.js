import { spawn } from "node:child_process";

/**
 * JSON-lines host client: one Python kernel host per client.
 *
 * Spawns `command` with `args`, parses stdout as JSON lines, and resolves
 * `exec` calls on the matching `done` event.
 */
export function createHostClient({
  command,
  args = [],
  cwd,
  env,
  onEvent = () => {},
  onStderr,
  graceMs = 10000,
} = {}) {
  // Only a positive `timeoutSec` arms the client-side hard cap; `graceMs` is
  // the extra budget on top of it for the host's stop handshake.
  const state = {
    exited: false,
    code: null,
    signal: null,
    fatalError: null,
    pending: new Map(),
  };

  let child = null;
  let childError = null;
  let buffer = "";
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const rejectAll = (error) => {
    const pending = [...state.pending.values()];
    state.pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  };

  const finalize = (code, signal, error) => {
    if (state.exited) return;
    state.exited = true;
    state.code = code ?? null;
    state.signal = signal ?? null;

    if (buffer.trim() !== "") {
      const rest = buffer;
      buffer = "";
      handleLine(rest);
    }

    const suffix =
      code !== null && code !== undefined
        ? ` with code ${code}`
        : signal
          ? ` on signal ${signal}`
          : "";
    const reason = error
      ? new Error(`kernel host failed: ${error.message}`)
      : new Error(`kernel host exited${suffix}`);
    rejectAll(reason);
    resolveExit({ code: code ?? null, signal: signal ?? null });
  };

  const writeLine = (payload) => {
    if (state.exited) return false;
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const settle = (id, result) => {
    const entry = state.pending.get(id);
    if (!entry) return;
    state.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(result);
  };

  const route = (event) => {
    if (event.op === "done" && typeof event.id === "string") {
      settle(event.id, {
        status: event.status,
        executionCount: event.executionCount,
        lost: event.lost === true,
      });
      return;
    }

    if (event.op === "fatal") {
      const detail = event.traceback ? `\n${event.traceback}` : "";
      state.fatalError = new Error(
        `kernel host fatal: ${event.message ?? "unknown error"}${detail}`,
      );
      rejectAll(state.fatalError);
    }
  };

  const handleLine = (line) => {
    const text = line.trim();
    if (text === "") return;

    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) return;

    try {
      onEvent(event);
    } catch {
      // a throwing listener must not break framing
    }

    route(event);
  };

  try {
    child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    child = null;
    childError = error;
    finalize(null, null, error);
  }

  if (child) {
    child.on("error", (error) => {
      childError = error;
    });
    child.on("close", (code, signal) => {
      finalize(code, signal, childError);
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
      }
    });

    child.stderr?.setEncoding("utf8");
    if (typeof onStderr === "function") {
      child.stderr?.on("data", (chunk) => {
        try {
          onStderr(chunk);
        } catch {
          // listener failures are not fatal
        }
      });
    } else {
      child.stderr?.on("data", () => {});
    }
  }

  const exec = ({ id, code, timeoutSec, reset } = {}) =>
    new Promise((resolve, reject) => {
      if (typeof id !== "string" || id === "") {
        reject(new TypeError("exec requires an id"));
        return;
      }
      if (state.exited) {
        reject(new Error("kernel host has exited"));
        return;
      }
      if (state.fatalError) {
        reject(state.fatalError);
        return;
      }
      if (state.pending.has(id)) {
        reject(new Error(`duplicate exec id: ${id}`));
        return;
      }

      const seconds = Number(timeoutSec);
      const grace = Number(graceMs);
      const limitMs =
        Number.isFinite(seconds) && seconds > 0
          ? Math.round(seconds * 1000) + (Number.isFinite(grace) && grace > 0 ? grace : 0)
          : 0;

      let timer = null;
      if (limitMs > 0) {
        timer = setTimeout(() => {
          state.pending.delete(id);
          const error = new Error(`kernel call ${id} timed out after ${limitMs} ms`);
          error.code = "HOST_TIMEOUT";
          reject(error);
        }, limitMs);
        if (typeof timer.unref === "function") timer.unref();
      }

      state.pending.set(id, { resolve, reject, timer });

      if (!writeLine({ op: "exec", id, code, timeoutSec, reset: reset === true })) {
        state.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error("kernel host stdin is not writable"));
      }
    });

  const interrupt = () => writeLine({ op: "interrupt" });

  const shutdown = () => {
    if (state.exited) return Promise.resolve({ code: state.code, signal: state.signal });
    writeLine({ op: "shutdown" });
    return exitPromise;
  };

  const kill = () => {
    if (!child || state.exited) return false;
    try {
      return child.kill("SIGKILL");
    } catch {
      return false;
    }
  };

  return {
    exec,
    interrupt,
    shutdown,
    kill,
    get pid() {
      return child?.pid;
    },
    get exited() {
      return state.exited;
    },
  };
}

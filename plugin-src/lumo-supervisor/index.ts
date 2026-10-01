// lumo-supervisor: local OpenCode v2 plugin that supervises the lumo-tamer
// proxy server and registers its OpenAI-compatible provider in order.
//
// On load:
//   1. Probe http://127.0.0.1:<port>/health with a short per-attempt timeout
//      and a ~3s total budget. Healthy -> adopt mode: never spawn, never kill.
//   2. Unhealthy -> if <stateDir>/lumo-supervisor.pid names a live pid,
//      another supervisor instance owns the server: adopt mode. A stale pid
//      file (dead pid) is removed first, then the server is spawned once
//      (no respawn loop).
//   3. Spawn detached from this process group, cwd = checkoutDir, command
//      ["node", <checkoutDir>/dist/src/tamer.js, "server"], stdout and stderr
//      appended to <stateDir>/server.log (directory created on demand), pid
//      written to <stateDir>/lumo-supervisor.pid.
//   4. Poll health every ~500ms until success or healthTimeoutMs. A timeout
//      never throws: warn naming server.log, and when its tail contains
//      "Vault not found" append the interactive-auth hint. The tail (at most
//      the last 20 lines) is read ONLY to detect that marker - it is never
//      printed and never attached to any log record.
//   5. AFTER the health decision, register provider "lumo-tamer" (package
//      @opencode/ai/providers/openai-compatible) with models lumo, lumo-lite,
//      lumo-max via ctx.provider.transform - regardless of health outcome.
//      A missing checkout or dead spawn only warns; registration proceeds.
//
// On unload (cleanup): only if THIS instance spawned the server. The recorded
// pid is signaled only when ALL of these gates hold: the child has not
// exited, the pid is still alive, and a fresh read of the pid file still
// names that pid. When signaled: SIGTERM, wait up to 5s for exit, escalate
// to SIGKILL, then remove the pid file; when any gate fails, only the pid
// file is removed. Adopt mode does nothing to the server (and leaves its
// pid file). Safe against double invocation. Additionally, because
// `opencode service stop` never runs plugin unload, setup() registers a
// synchronous process "exit" listener that re-applies these same gates and
// best-effort SIGTERMs a still-running spawned server (then removes the pid
// file); signal listeners (SIGTERM/SIGINT/beforeExit) are deliberately
// avoided because one could block the service's default termination and hang
// a direct kill -TERM, while an "exit" listener cannot prevent exit. When
// those gates pass and the hook signals the server, it records that fact to
// the private supervisor.log (SUPERVISOR_LOG), which is how the post-auth
// verification of the hook will be observed.
//
// apiKey resolution: contents of secrets/lumo_api_key (trimmed) ->
// process.env.LUMO_API_KEY -> "" plus a warning (requests 401 until the key
// file exists). The key value is never logged; at most its length is.
//
// Options (ctx.options, all with defaults): checkoutDir (default
// "~/.config/opencode/lumo-tamer", leading ~ expanded via os.homedir()),
// port (default 3003), healthTimeoutMs (default 20000).
//
// Node builtins + the @opencode/plugin API only; no npm dependencies.
// All files ASCII only.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { Model, Plugin, Provider } from "@opencode/plugin";

const PROVIDER_ID = "lumo-tamer";
const DEFAULT_CHECKOUT_DIR = "~/.config/opencode/lumo-tamer";
const DEFAULT_PORT = 3003;
const DEFAULT_HEALTH_TIMEOUT_MS = 20000;

// Initial health probe budget before the spawn/adopt decision.
const PROBE_BUDGET_MS = 3000;
const PROBE_ATTEMPT_MS = 750;
const PROBE_RETRY_GAP_MS = 150;
// Post-spawn polling cadence and per-attempt timeout (~500ms cycle).
const POLL_INTERVAL_MS = 500;
const POLL_ATTEMPT_MS = 450;
// Cleanup: grace period before SIGKILL escalation.
const SHUTDOWN_GRACE_MS = 5000;
const SHUTDOWN_POLL_MS = 100;
// server.log tail: at most this many lines are ever read (only to detect the
// vault marker; never printed and never attached to log records).
const TAIL_MAX_LINES = 20;
const TAIL_WINDOW_BYTES = 8192;

const API_KEY_FILE = join(homedir(), ".config", "opencode", "secrets", "lumo_api_key");
const STATE_DIR = join(homedir(), ".local", "state", "lumo-supervisor");
const SERVER_LOG = join(STATE_DIR, "server.log");
const PID_FILE = join(STATE_DIR, "lumo-supervisor.pid");
// Private JSONL decision log. Promise plugins cannot reach the opencode log
// file (upstream anomalyco/opencode#27285; see plugin-src/fusion-tools/lib/
// log.js), so this file is the persisted, diagnosable record of every
// decision: {ts, service, level, message, ...extra}. Created lazily on first
// write. Never receives key material (length-only rule for apiKey).
const SUPERVISOR_LOG = join(STATE_DIR, "supervisor.log");

const AUTH_HINT =
  "interactive auth is required: run `tamer auth` (use the browser or rclone method; login needs Go)";

const MODEL_SPECS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "lumo", name: "Lumo (auto-route)" },
  { id: "lumo-lite", name: "Lumo Lite" },
  { id: "lumo-max", name: "Lumo Max" },
];

// Last directory successfully created for SUPERVISOR_LOG (mirrors
// plugin-src/fusion-tools/lib/log.js: mkdir once, on demand).
let logDirReady = false;

// Structured logging: console (promise plugins cannot reach the opencode log
// file; see plugin-src/fusion-tools/lib/log.js) AND an appended JSONL line
// in SUPERVISOR_LOG, created lazily (directory + file on first write).
// Never throws, never prints secret values.
function log(
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  let line: string;
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      service: "lumo-supervisor",
      level,
      message,
      ...(extra ?? {}),
    });
  } catch {
    // cyclic/non-serializable extra: do not throw over logging
    return;
  }
  try {
    console.log(line);
  } catch {
    // logging must never break setup or cleanup
  }
  try {
    appendFileSync(SUPERVISOR_LOG, line + "\n");
    return;
  } catch {
    // fall through to the dir-creation retry
  }
  if (!logDirReady) {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      logDirReady = true;
    } catch {
      // best-effort only
    }
  }
  try {
    appendFileSync(SUPERVISOR_LOG, line + "\n");
  } catch {
    // still failing - give up silently
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expandTilde(target: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  return target;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

// One health GET against 127.0.0.1:<port>/health with a per-attempt timeout.
// Resolves true on a 2xx status; never rejects.
function probeOnce(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const req = httpGet(
      { host: "127.0.0.1", port, path: "/health", timeout: timeoutMs },
      (res) => {
        const code = res.statusCode ?? 0;
        res.resume();
        settle(code >= 200 && code < 300);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      settle(false);
    });
    req.on("error", () => settle(false));
  });
}

// Repeated probing until success or the total budget is exhausted.
async function probeWithBudget(
  port: number,
  budgetMs: number,
  attemptMs: number
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (await probeOnce(port, Math.min(attemptMs, remaining))) return true;
    const after = deadline - Date.now();
    if (after <= 0) return false;
    await sleep(Math.min(PROBE_RETRY_GAP_MS, after));
  }
}

// Post-spawn polling: attempt, then wait POLL_INTERVAL_MS, until success or
// the health timeout elapses. Returns false on timeout; never throws.
async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeOnce(port, POLL_ATTEMPT_MS)) return true;
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
  return false;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user - still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPidFile(): number | undefined {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    if (!raw) return undefined;
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

// Last <= maxLines lines of server.log, read via a bounded byte window at
// the end of the file (never the whole file). Missing/unreadable file -> [].
function readLogTail(path: string, maxLines: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_WINDOW_BYTES);
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      // Drop the first (possibly partial) line when the window is truncated.
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : text;
    }
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

// Spawn the lumo-tamer server detached from this process group with stdout
// and stderr appended to SERVER_LOG. The parent's copy of the log fd is
// closed before returning; the child keeps its own.
function spawnServer(checkoutDir: string): ChildProcess {
  mkdirSync(STATE_DIR, { recursive: true });
  const logFd = openSync(SERVER_LOG, "a");
  try {
    const options: SpawnOptions = {
      cwd: checkoutDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    };
    return spawn("node", [join(checkoutDir, "dist", "src", "tamer.js"), "server"], options);
  } finally {
    closeSync(logFd);
  }
}

// Pinned resolution order: key file (trimmed) -> env -> empty string.
function resolveApiKey(): { key: string; source: "file" | "env" | "none" } {
  try {
    const fromFile = readFileSync(API_KEY_FILE, "utf8").trim();
    if (fromFile) return { key: fromFile, source: "file" };
  } catch {
    // missing/empty key file falls through to the environment
  }
  const fromEnv = process.env.LUMO_API_KEY;
  if (fromEnv) return { key: fromEnv, source: "env" };
  return { key: "", source: "none" };
}

// Health-timeout warning: names server.log, and if its tail contains the
// fatal vault marker, appends the interactive-auth hint. The raw tail is
// deliberately NEVER attached to the record: third-party output can carry an
// api_key prefix, so it must not reach opencode's logs. Never throws.
function warnHealthTimeout(pid: number, healthTimeoutMs: number): void {
  let msg =
    "server not healthy within healthTimeoutMs; continuing anyway - see " +
    SERVER_LOG;
  const extra: Record<string, unknown> = {
    pid,
    healthTimeoutMs,
    serverLog: SERVER_LOG,
  };
  try {
    const tail = readLogTail(SERVER_LOG, TAIL_MAX_LINES);
    if (tail.some((line) => line.includes("Vault not found"))) {
      msg +=
        "; log tail contains 'Vault not found' - " + AUTH_HINT;
    }
  } catch {
    // tail is best-effort; the warning still names server.log
  }
  log("warn", msg, extra);
}

export default Plugin.define({
  id: "lumo-supervisor",
  async setup(ctx) {
    const raw = (ctx.options ?? {}) as Record<string, unknown>;
    const checkoutDir = expandTilde(
      typeof raw.checkoutDir === "string" && raw.checkoutDir
        ? raw.checkoutDir
        : DEFAULT_CHECKOUT_DIR
    );
    const port = positiveNumber(raw.port, DEFAULT_PORT);
    const healthTimeoutMs = positiveNumber(
      raw.healthTimeoutMs,
      DEFAULT_HEALTH_TIMEOUT_MS
    );

    log("info", "setup (load/reload)", { checkoutDir, port, healthTimeoutMs });

    let spawnedPid: number | undefined;
    let childExited = false;

    // ---------------- health decision (steps 1-4) ----------------
    try {
      const healthy = await probeWithBudget(port, PROBE_BUDGET_MS, PROBE_ATTEMPT_MS);
      if (healthy) {
        log("info", "server already healthy; adopt mode (never spawn, never kill)", {
          port,
        });
      } else {
        const existingPid = readPidFile();
        if (existingPid !== undefined && isPidAlive(existingPid)) {
          log(
            "info",
            "pid file names a live pid; another supervisor instance owns the server - adopt mode",
            { pid: existingPid }
          );
        } else {
          if (existsSync(PID_FILE)) {
            log("info", "stale pid file found; removing before spawn", {
              pid: existingPid ?? null,
            });
            try {
              rmSync(PID_FILE, { force: true });
            } catch (err) {
              log("warn", "failed to remove stale pid file", {
                error: String(err),
              });
            }
          }
          // Spawn ONCE - no respawn loop. A missing checkout (parallel
          // install not finished yet) only warns; never fails hard.
          let child: ChildProcess | undefined;
          try {
            child = spawnServer(checkoutDir);
          } catch (err) {
            log("warn", "spawn failed; continuing without a server", {
              checkoutDir,
              error: String(err),
            });
          }
          if (child) {
            child.on("exit", () => {
              childExited = true;
            });
            child.on("error", (err) => {
              log("warn", "server process error", { error: err.message });
            });
            child.unref();
            const pid = child.pid;
            if (typeof pid === "number") {
              spawnedPid = pid;
              try {
                writeFileSync(PID_FILE, String(pid), "utf8");
              } catch (err) {
                log("warn", "failed to write pid file", { error: String(err) });
              }
              log("info", "spawned lumo-tamer server", { pid, checkoutDir });
              const up = await waitForHealth(port, healthTimeoutMs);
              if (up) {
                log("info", "server healthy after spawn", { pid });
              } else {
                warnHealthTimeout(pid, healthTimeoutMs);
              }
            } else {
              log("warn", "spawn produced no pid; server not started, continuing", {
                checkoutDir,
              });
            }
          }
        }
      }
    } catch (err) {
      log("warn", "supervision step failed; continuing to provider registration", {
        error: String(err),
      });
    }

    // ---------------- provider registration (step 5) ----------------
    // Runs after the health decision regardless of its outcome.
    try {
      const apiKey = resolveApiKey();
      if (apiKey.source === "none") {
        log(
          "warn",
          "no API key found (checked " +
            API_KEY_FILE +
            " then env LUMO_API_KEY); registering the provider with an empty apiKey - requests will 401 until the key file exists",
          { keyFile: API_KEY_FILE, keyLength: 0 }
        );
      } else {
        // Never log the key value itself - length only.
        log("info", "api key resolved", {
          source: apiKey.source,
          keyLength: apiKey.key.length,
        });
      }

      const providerID = Provider.ID.make(PROVIDER_ID);
      const info: Provider.Info = {
        ...Provider.Info.empty(providerID),
        name: "Lumo Tamer",
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: "http://127.0.0.1:" + port + "/v1",
          apiKey: apiKey.key,
        },
      };
      // Model.Info fields (verified against the installed .d.ts):
      // capabilities = {tools, input[], output[]} - tool calls are
      // capabilities.tools, image input is "image" in capabilities.input;
      // limit = {context, input?, output} - both limit fields exist.
      const models: Model.Info[] = MODEL_SPECS.map((spec) => ({
        ...Model.Info.default(providerID, Model.ID.make(spec.id)),
        name: spec.name,
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        limit: { context: 131072, output: 8192 },
      }));
      await ctx.provider.transform((editor) => {
        editor.add({ info, models });
      });
      log("info", "provider registered", {
        provider: PROVIDER_ID,
        baseURL: info.settings?.baseURL,
        models: MODEL_SPECS.map((spec) => spec.id),
      });
    } catch (err) {
      log("error", "provider registration failed", { error: String(err) });
    }

    // ---------------- cleanup (step 6) ----------------
    let cleanedUp = false;

    // Process-exit best-effort kill: `opencode service stop` does not invoke
    // plugin unload/cleanup, so a post-auth running tamer would orphan. The
    // "exit" listener is synchronous and fire-and-forget (no async waits);
    // signal listeners are deliberately NOT registered because one could
    // block the service's default termination and hang a direct kill -TERM,
    // while "exit" cannot prevent exit. Gates: only when THIS instance
    // spawned the server, the child has not exited, the pid is alive, and
    // a fresh pid file read still names it. Each setup() call registers its
    // own listener with its
    // own guards, so an adopting instance's hook does nothing. Never throws.
    process.on("exit", () => {
      try {
        if (spawnedPid === undefined) return;
        const pid = spawnedPid;
        if (childExited || !isPidAlive(pid) || readPidFile() !== pid) return;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // best-effort only; exit listeners must not throw
        }
        log("info", "exit hook: signaled spawned server", { pid: pid });
        try {
          rmSync(PID_FILE, { force: true });
        } catch {
          // best-effort only; exit listeners must not throw
        }
      } catch {
        // never throw inside an exit listener
      }
    });

    return async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (spawnedPid === undefined) {
        log(
          "info",
          "cleanup: this instance did not spawn the server (adopt mode or spawn failed); leaving any running server untouched"
        );
        return;
      }
      const pid = spawnedPid;
      // Signal only when ALL of these hold: this instance's child has not
      // exited, the recorded pid is still alive (not dead/recycled), and a
      // fresh read of the state pidfile still names THIS pid (another
      // instance has not taken over). Otherwise the pid may belong to an
      // unrelated process - skip signaling and just drop the pid file.
      const safeToSignal =
        !childExited && isPidAlive(pid) && readPidFile() === pid;
      if (!safeToSignal) {
        log(
          "info",
          "cleanup: not signaling (child exited, pid dead, or pid file no longer names this pid); removing pid file only",
          { pid, childExited }
        );
      } else {
        try {
          process.kill(pid, "SIGTERM");
        } catch (err) {
          log("warn", "cleanup: SIGTERM failed", { pid, error: String(err) });
        }
        const deadline = Date.now() + SHUTDOWN_GRACE_MS;
        while (Date.now() < deadline && !childExited && isPidAlive(pid)) {
          await sleep(SHUTDOWN_POLL_MS);
        }
        if (!childExited && isPidAlive(pid)) {
          log("warn", "cleanup: still alive after grace period; escalating to SIGKILL", {
            pid,
          });
          try {
            process.kill(pid, "SIGKILL");
          } catch (err) {
            log("warn", "cleanup: SIGKILL failed", { pid, error: String(err) });
          }
        }
      }
      try {
        rmSync(PID_FILE, { force: true });
      } catch (err) {
        log("warn", "cleanup: failed to remove pid file", { error: String(err) });
      }
      log("info", "cleanup: stopped server spawned by this instance", { pid });
    };
  },
});

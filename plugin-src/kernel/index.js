// kernel plugin: persistent Python cells through a JSON-lines host.
//
// Two tools are registered:
//   kernel        - run one cell in the session's kernel (state persists across
//                   calls and compaction; subagents own separate kernels)
//   kernel_export - export the session journal to a .ipynb notebook without a
//                   live kernel
//
// The host protocol lives in host.py / lib/host-client.js, per-session LRU
// bookkeeping in lib/registry.js, interpreter selection in lib/discovery.js,
// output formatting in lib/format.js, and export in lib/export.js.

import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Plugin } from "@opencode/plugin";

import { resolveKernel } from "./lib/discovery.js";
import { defaultExportPython, exportNotebook } from "./lib/export.js";
import { formatResult } from "./lib/format.js";
import { createHostClient } from "./lib/host-client.js";
import { sessionPaths } from "./lib/paths.js";
import { createRegistry } from "./lib/registry.js";

const DEFAULT_HOST_SCRIPT = fileURLToPath(new URL("./host.py", import.meta.url));
const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 3600;

export const KERNEL_DESCRIPTION = [
  "Run one Python cell in the session's persistent kernel; Python is the",
  "default language. State (variables,",
  "imports, loaded data) persists across calls and across context compaction;",
  "subagents get their own separate kernel, not the parent's.",
  "",
  "One cell per call: put a single logical step in each call and read the",
  "output before sending the next one.",
  "",
  "kernel selects the interpreter: an absolute Python path (a conda or venv",
  "interpreter) or a kernelspec name. Leave it empty to auto-detect from the",
  "project (.venv, venv, CONDA_PREFIX, VIRTUAL_ENV) and PATH.",
  "",
  "timeout is in seconds, defaults to 30, 0 disables it, and 3600 is the",
  "maximum. reset restarts the kernel (optionally switching kernel) before",
  "running the cell. Use kernel_export to save the session as a notebook.",
].join("\n");

export const KERNEL_EXPORT_DESCRIPTION = [
  "Export the session's recorded cells to a Jupyter notebook (.ipynb).",
  "The path is relative to the session project unless absolute, and .ipynb",
  "is appended when missing. Works after the kernel was evicted, and errors",
  "with 'session has no recorded cells; nothing written' when nothing ran.",
].join("\n");

export function requireSession(context) {
  const sessionID =
    context && typeof context.sessionID === "string" ? context.sessionID : "";
  if (sessionID === "") throw new Error("kernel requires a session id");
  return sessionID;
}

/**
 * Resolve the session's project directory. Prefers the session record, then
 * the plugin location, then the process working directory.
 */
export async function resolveProjectDirectory(ctx, sessionID) {
  const sessionApi = ctx && ctx.session;
  if (sessionApi && typeof sessionApi.get === "function") {
    try {
      const response = await sessionApi.get({ sessionID });
      const session =
        response &&
        typeof response === "object" &&
        response.data &&
        typeof response.data === "object"
          ? response.data
          : response;
      const directory = session?.location?.directory;
      if (typeof directory === "string" && directory !== "") return directory;
    } catch {
      // fall through to the location / cwd fallbacks
    }
  }

  const location = ctx && ctx.location;
  if (location && typeof location.directory === "string" && location.directory !== "") {
    return location.directory;
  }

  return process.cwd();
}

function createSessionHost({
  sessionID,
  projectDir,
  selection,
  hostPython,
  paths,
  createHost,
  hostScript,
}) {
  const state = { current: null };

  const client = createHost({
    command: hostPython,
    args: [
      hostScript,
      "--kernel",
      selection,
      "--cwd",
      projectDir,
      "--journal",
      paths.journal,
      "--meta",
      paths.meta,
    ],
    cwd: projectDir,
    onEvent: (event) => {
      if (!event || typeof event !== "object") return;
      const current = state.current;
      if (!current) return;
      if (typeof event.id === "string" && event.id !== current.id) return;
      current.events.push(event);
    },
  });

  return {
    sessionID,
    projectDir,
    selection,
    hostPython,
    get pid() {
      return client.pid;
    },
    get exited() {
      return client.exited === true;
    },
    async exec({ id, code, timeoutSec, reset }) {
      const current = { id, events: [] };
      state.current = current;
      try {
        const outcome = await client.exec({ id, code, timeoutSec, reset });
        return { events: current.events, ...outcome };
      } finally {
        if (state.current === current) state.current = null;
      }
    },
    interrupt() {
      return client.interrupt();
    },
    shutdown() {
      return client.shutdown();
    },
  };
}

function normalizeInput(input) {
  const value = input && typeof input === "object" ? input : {};

  if (value.code !== undefined && typeof value.code !== "string") {
    throw new Error("kernel code must be a string");
  }

  if (value.reset !== undefined && typeof value.reset !== "boolean") {
    throw new Error("kernel reset must be a boolean");
  }
  const reset = value.reset === true;

  let timeout = DEFAULT_TIMEOUT_SEC;
  if (value.timeout !== undefined) {
    if (
      typeof value.timeout !== "number" ||
      !Number.isFinite(value.timeout) ||
      value.timeout < 0
    ) {
      throw new Error("kernel timeout must be a number of seconds between 0 and 3600");
    }
    if (value.timeout > MAX_TIMEOUT_SEC) {
      throw new Error("kernel timeout must be at most 3600 seconds");
    }
    timeout = value.timeout;
  }

  let kernel;
  if (value.kernel !== undefined) {
    if (typeof value.kernel !== "string") {
      throw new Error("kernel must be a Python path or kernelspec name");
    }
    const trimmed = value.kernel.trim();
    if (trimmed !== "") kernel = trimmed;
  }

  return { code: value.code, reset, timeout, kernel };
}

/**
 * Build both tool handlers. `registry`, `createHost`, `resolveSelection`,
 * `resolveProjectDir`, `exportRunner`, and `pathsForSession` are seams for
 * tests; the plugin supplies the real implementations through `setup`.
 */
export function createKernelTools({
  registry,
  createHost = createHostClient,
  resolveSelection = resolveKernel,
  resolveProjectDir = async () => process.cwd(),
  exportRunner = exportNotebook,
  hostScript = DEFAULT_HOST_SCRIPT,
  pathsForSession = (sessionID) => sessionPaths(sessionID),
  maxHosts = 4,
  env = process.env,
  now = Date.now,
  log = (message) => {
    try {
      console.error(message);
    } catch {
      // logging must never break a tool call
    }
  },
} = {}) {
  const spawnHost = async ({ sessionID, projectDir, selection, hostPython }) => {
    const paths = pathsForSession(sessionID);
    await mkdir(paths.dir, { recursive: true });
    return createSessionHost({
      sessionID,
      projectDir,
      selection,
      hostPython,
      paths,
      createHost,
      hostScript,
    });
  };

  const hostRegistry =
    registry ?? createRegistry({ max: maxHosts, spawnHost, now, log });

  const kernel = {
    name: "kernel",
    description: KERNEL_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: {
          type: "string",
          description: "Python source for one cell. Required unless reset is true.",
        },
        timeout: {
          type: "number",
          description: "Seconds before the cell is stopped; default 30, 0 disables, max 3600.",
        },
        reset: {
          type: "boolean",
          description: "Restart the kernel (optionally switching kernel) before the cell.",
        },
        kernel: {
          type: "string",
          description: "Absolute Python path (conda/venv) or kernelspec name.",
        },
      },
    },
    async execute(input, context) {
      const sessionID = requireSession(context);
      const opts = normalizeInput(input);
      const paths = pathsForSession(sessionID);
      const projectDir = await resolveProjectDir(sessionID, context);
      const hasCode = typeof opts.code === "string" && opts.code.trim() !== "";

      if (!hasCode && !opts.reset) {
        throw new Error("no cell to run; pass code or reset:true");
      }

      const existing = hostRegistry.get(sessionID);
      if (existing && existing.busy) {
        throw new Error("a cell is already running in this session");
      }
      let entry =
        existing && existing.host && existing.host.exited !== true ? existing : null;

      if (entry) {
        if (
          opts.kernel !== undefined &&
          opts.kernel !== entry.host.selection &&
          !opts.reset
        ) {
          throw new Error(
            `selection changed from ${entry.host.selection} to ${opts.kernel}; pass reset:true`,
          );
        }
      }

      if (
        entry &&
        opts.reset &&
        opts.kernel !== undefined &&
        opts.kernel !== entry.host.selection
      ) {
        await hostRegistry.delete(sessionID);
        entry = null;
      }

      const startedFresh = entry === null;
      const startedAt = now();

      try {
        if (entry === null) {
          const resolved = await resolveSelection({
            requested: opts.kernel ?? "",
            projectDir,
            env,
          });
          entry = await hostRegistry.ensure(sessionID, {
            projectDir,
            selection: resolved.selection,
            hostPython: resolved.hostPython,
          });
        } else {
          entry = await hostRegistry.ensure(sessionID, {
            projectDir,
            selection: entry.host.selection,
            hostPython: entry.host.hostPython,
          });
        }

        if (!hasCode) {
          if (!startedFresh) {
            // Reset-only on a live host: restart it, then confirm instead of
            // surfacing the empty cell's formatted output.
            await entry.host.exec({
              id: crypto.randomUUID(),
              code: "",
              timeoutSec: opts.timeout,
              reset: true,
            });
          }
          return {
            content: `Kernel reset: ${entry.host.selection}`,
            metadata: {
              status: "reset",
              kernel: entry.host.selection,
              executionCount: 0,
            },
          };
        }

        const id = crypto.randomUUID();
        const reset = opts.reset === true && !startedFresh;
        const signal = context && context.signal;
        const onAbort = () => {
          try {
            entry.host.interrupt();
          } catch (error) {
            log(`[kernel] interrupt failed: ${error?.message ?? String(error)}`);
          }
        };
        if (signal && typeof signal.addEventListener === "function") {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        let outcome;
        try {
          outcome = await entry.host.exec({
            id,
            code: opts.code ?? "",
            timeoutSec: opts.timeout,
            reset,
          });
        } finally {
          if (signal && typeof signal.removeEventListener === "function") {
            signal.removeEventListener("abort", onAbort);
          }
        }

        const formatted = await formatResult(outcome.events, {
          imagesDir: paths.imagesDir,
          logsDir: paths.logsDir,
        });
        const executionCount =
          typeof outcome.executionCount === "number"
            ? outcome.executionCount
            : formatted.executionCount;

        return {
          content: formatted.text,
          metadata: {
            sessionID,
            kernel: entry.host.selection,
            executionCount,
            status: formatted.status,
            images: formatted.images,
            logPath: formatted.logPath,
            truncated: formatted.truncated,
            durationMs: now() - startedAt,
          },
        };
      } finally {
        if (entry) entry.busy = false;
      }
    },
  };

  const kernelExport = {
    name: "kernel_export",
    description: KERNEL_EXPORT_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Notebook path; relative to the session project, .ipynb appended when missing.",
        },
        title: {
          type: "string",
          description: "Optional notebook title.",
        },
      },
      required: ["path"],
    },
    async execute(input, context) {
      const sessionID = requireSession(context);
      const value = input && typeof input === "object" ? input : {};
      if (typeof value.path !== "string" || value.path.trim() === "") {
        throw new Error("kernel_export requires a path");
      }
      if (value.title !== undefined && typeof value.title !== "string") {
        throw new Error("kernel_export title must be a string");
      }

      const existing = hostRegistry.get(sessionID);
      if (existing && existing.busy) {
        throw new Error(
          "a cell is already running in this session; export after it finishes",
        );
      }

      const projectDir = await resolveProjectDir(sessionID, context);
      let out = value.path.trim();
      if (path.extname(out).toLowerCase() !== ".ipynb") out += ".ipynb";
      out = path.isAbsolute(out) ? path.normalize(out) : path.resolve(projectDir, out);

      const paths = pathsForSession(sessionID);
      const result = await exportRunner({
        python: defaultExportPython(env),
        hostScript,
        journal: paths.journal,
        meta: paths.meta,
        out,
        title: value.title,
      });

      return {
        content: `Exported ${result.cells} cells to ${result.path}`,
        metadata: {
          path: result.path,
          cells: result.cells,
          truncated: result.truncated === true,
        },
      };
    },
  };

  function handleEvent(event) {
    if (!event || typeof event !== "object" || event.type !== "session.deleted") {
      return;
    }
    const data = event.data && typeof event.data === "object" ? event.data : {};
    const properties =
      event.properties && typeof event.properties === "object" ? event.properties : {};
    const sessionID = data.sessionID ?? properties.sessionID;
    if (typeof sessionID !== "string" || sessionID === "") return;
    void hostRegistry.delete(sessionID);
  }

  const shutdown = async () => {
    await hostRegistry.shutdownAll();
  };

  return {
    tools: { kernel, kernel_export: kernelExport },
    registry: hostRegistry,
    pathsForSession,
    handleEvent,
    shutdown,
  };
}

export function addKernelTools(editor, tools) {
  editor.add(tools.kernel);
  editor.add(tools.kernel_export);
}

export default Plugin.define({
  id: "kernel",
  async setup(ctx) {
    const surface = createKernelTools({
      resolveProjectDir: (sessionID) => resolveProjectDirectory(ctx, sessionID),
    });

    const registration = await ctx.tool.transform((editor) =>
      addKernelTools(editor, surface.tools),
    );

    let closing = false;
    let iterator = null;
    const controller = new AbortController();

    if (ctx.event && typeof ctx.event.subscribe === "function") {
      void (async () => {
        try {
          const stream = ctx.event.subscribe();
          iterator = stream[Symbol.asyncIterator]();
          while (!closing) {
            const { value, done } = await iterator.next();
            if (done || closing) break;
            surface.handleEvent(value);
          }
        } catch {
          // a closed subscription is expected during unload
        }
        try {
          if (iterator && typeof iterator.return === "function") {
            await iterator.return();
          }
        } catch {
          // ignore
        }
      })();
    }

    const onSignal = () => {
      void surface.shutdown().catch(() => {});
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    let unloaded = false;
    return async () => {
      if (unloaded) return;
      unloaded = true;
      closing = true;
      controller.abort();
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      try {
        await registration?.dispose();
      } catch {
        // ignore
      }
      try {
        if (iterator && typeof iterator.return === "function") {
          await iterator.return();
          iterator = null;
        }
      } catch {
        // ignore
      }
      await surface.shutdown();
    };
  },
});

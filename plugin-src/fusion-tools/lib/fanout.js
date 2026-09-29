// fusion-tools: fanout module (Phase 2).
//
// Splits a job across parallel worker sessions, each isolated in its own git
// worktree, and returns schema-validated typed results to the caller.
//
// Two global tools:
//   fanout        - called by the parent: creates worktrees + worker sessions,
//                   waits all-settled, returns the typed result envelope.
//   submit_result - called by a worker to report data/error; schema
//                   validation and the permissive/strict retry budget
//                   (MAX_SCHEMA_RETRIES) live here.
//
// Worker records are keyed by workerSessionID in this generation's state and
// freed when the fanout run completes. Completed-run records are persisted
// under "fusion-tools/fanout/<fanoutID>" via the shared storage adapter (the
// orphan sweep reads them at setup). Git access is delegated to
// lib/worktree.js (injectable via deps.worktree for tests).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { log } from "./log.js";
import * as worktreeImpl from "./worktree.js";
import { composeWorkerPrompt } from "./workerprompt.js";
import { validateSchema } from "./jsonschema.js";

export const STORAGE_PREFIX = "fusion-tools/fanout/";
export const MAX_SCHEMA_RETRIES = 3;

// Cross-generation worker registry. Plugin generations are per-project AND
// per-module-evaluation (a worker session can live in a different project -
// its worktree directory - than the caller's fanout, and that project's
// plugin instance evaluates this module separately). State must therefore be
// shared through the filesystem, not through module or setup scope: one JSON
// file per pending worker under ~/.cache/opencode/fusion-tools/worker-state/.
// The in-memory map is the same-instance fast path; the file is the
// cross-instance channel. Entries are removed when the owning run completes
// or its generation cleans up.
const WORKER_REGISTRY = new Map(); // workerSessionID -> pending worker record

const WORKER_STATE_DIR = path.join(
  homedir(),
  ".cache",
  "opencode",
  "fusion-tools",
  "worker-state",
);

function workerStateFile(workerSessionID) {
  const safe = String(workerSessionID).replace(/[^A-Za-z0-9_-]/g, "");
  return path.join(WORKER_STATE_DIR, safe + ".json");
}

function registrySet(record) {
  WORKER_REGISTRY.set(record.workerSessionID, record);
  try {
    mkdirSync(WORKER_STATE_DIR, { recursive: true });
    writeFileSync(workerStateFile(record.workerSessionID), JSON.stringify(record));
  } catch {
    // best effort; the in-memory entry still serves same-instance submits
  }
}

function registryGet(workerSessionID) {
  const mem = WORKER_REGISTRY.get(workerSessionID);
  if (mem) return mem;
  try {
    const parsed = JSON.parse(readFileSync(workerStateFile(workerSessionID), "utf8"));
    if (parsed && typeof parsed === "object") {
      WORKER_REGISTRY.set(workerSessionID, parsed);
      return parsed;
    }
  } catch {
    // absent or unreadable
  }
  return null;
}

// Bypasses the in-memory fast path: worker sessions live in the worktree's
// project, so their submit_result runs in a DIFFERENT plugin generation
// (separate module evaluation) whose only shared channel is the state file.
// The caller's in-memory record never sees those mutations, so decision
// points must re-read the file to pick up cross-instance submits.
function registryGetFresh(workerSessionID) {
  try {
    const parsed = JSON.parse(readFileSync(workerStateFile(workerSessionID), "utf8"));
    if (parsed && typeof parsed === "object") {
      WORKER_REGISTRY.set(workerSessionID, parsed);
      return parsed;
    }
  } catch {
    // absent or unreadable: fall back to the in-memory entry
  }
  return WORKER_REGISTRY.get(workerSessionID) || null;
}

function registryDelete(workerSessionID) {
  WORKER_REGISTRY.delete(workerSessionID);
  try {
    rmSync(workerStateFile(workerSessionID), { force: true });
  } catch {
    // best effort
  }
}

// Same predicate the advisor module uses inline; duplicated here so the
// fanout module stays self-contained (advisor behavior untouched).
export function isFusionToolsAgent(agent) {
  if (typeof agent !== "string") return false;
  return agent === "advisor" || agent.startsWith("worker") || agent.startsWith("fanout");
}

const FANOUT_DESCRIPTION =
  "Split a job across parallel worker sessions. Each task runs in its own agent session inside its own isolated git worktree (created detached from the current HEAD), so tasks can run concurrently. Rules of the contract: (1) tasks must be SELF-CONTAINED - each worker sees only its task text, the optional shared context, and its working directory, never this conversation; (2) siblings must not touch the same files - split work along file boundaries; (3) results come back as typed objects, each validated against that task's outputSchema when one is given; (4) results are NOT merged - worktrees and diff stats are retained for you to review, patch, and integrate yourself afterwards.";

const SUBMIT_DESCRIPTION =
  "Report the result of your fanout task. Call exactly once when done: pass the result object in `data` matching the JSON schema you were given, or set `error` instead if the task could not be completed.";

const SUBMIT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    data: {
      description:
        "The result value; must match the outputSchema you were given (if any). Any non-null JSON value is accepted when no schema is given.",
    },
    error: {
      type: "string",
      description:
        "Set INSTEAD of data when the task could not be completed. Explain why in one or two sentences.",
    },
  },
};

const FANOUT_TASK_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      description: "Short label; used in the worktree directory name and the result row.",
    },
    agent: {
      type: "string",
      description: "Subagent that runs this task.",
    },
    task: {
      type: "string",
      description:
        "Self-contained work description. State the files to create/edit and the expected outcome explicitly; the worker cannot see this conversation.",
    },
    outputSchema: {
      type: "object",
      description:
        "JSON Schema (subset) the result `data` must satisfy: type, properties, required, enum, items, minimum/maximum, minLength/maxLength, pattern, additionalProperties.",
    },
    timeoutMs: {
      type: "number",
      description: "Wall-clock timeout for this worker before it is interrupted.",
    },
    schemaMode: {
      type: "string",
      enum: ["permissive", "strict"],
      description:
        "What happens after 3 failed schema validations: permissive (default) records the data flagged invalid; strict refuses it (schema_refused).",
    },
  },
  required: ["task"],
};

function makeFanoutID() {
  return "fo_" + Date.now() + "-" + randomBytes(2).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Race helper that clears its timer when the race is decided, so finished
// runs do not leave a pending timeout keeping the process alive.
function timeoutGate(ms) {
  const value = Number(ms);
  const wait = Number.isFinite(value) && value > 0 ? value : 0;
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), wait);
  });
  return [promise, () => timer !== null && clearTimeout(timer)];
}

function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Last assistant message with non-empty text parts, joined. Returns null
// when the transcript carries no assistant text at all.
export function finalAssistantText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.type !== "assistant") continue;
    const parts = Array.isArray(m.content)
      ? m.content.filter(
          (p) => p && p.type === "text" && typeof p.text === "string" && p.text.trim(),
        )
      : [];
    if (parts.length > 0) {
      return parts.map((p) => p.text).join("\n").trim();
    }
  }
  return null;
}

export function createFanoutModule({ ctx, cfg, storage, shared, deps }) {
  const wt = deps && deps.worktree ? deps.worktree : worktreeImpl;

  const state = {
    closing: false,
    workers: new Map(), // workerSessionID -> pending worker record
  };

  const worktreeBase = wt.resolveWorktreeBase(cfg.worktreeBase);

  function worktreePathFor(fanoutID, index, name) {
    return path.join(worktreeBase, fanoutID, index + "-" + wt.sanitizeTaskName(name));
  }

  // Path-scoped ruleset for a worker session. The session's location IS the
  // worktree. v2 resolves rules with "last matching rule wins"
  // (permission.evaluate uses findLast, docs + v2.0.18 source), so the
  // catch-all deny sits FIRST as the lowest-priority fallback: any later
  // specific rule overrides it, and anything no later rule re-matches falls
  // through to the deny. Placing the catch-all LAST would make it the last
  // match for every check and deny everything below, including the allows.
  // Per-worker: each call interpolates that worker's own worktree path, so
  // edit/write are re-allowed ONLY inside that exact worktree (the blanket
  // edit/write denies hold everywhere else), while shell/exec-style actions
  // and subagent spawning are never re-allowed.
  function workerPermissions(worktreePath) {
    const base = String(worktreePath).replace(/\/+$/, "");
    return [
      { action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
      { action: "execute", resource: "*", effect: "deny" },
      { action: "edit", resource: "**", effect: "deny" },
      { action: "write", resource: "**", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      // Without this the session ruleset's catch-all deny strips the
      // submit_result tool from the worker's function list entirely.
      { action: "submit_result", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "edit", resource: base + "/**", effect: "allow" },
      { action: "write", resource: base + "/**", effect: "allow" },
    ];
  }

  // Model-facing retry/terminal decision after a failed validation.
  function retryOrFinalize(record, sessionID, issues) {
    const attempt = record.attempts;
    const issueList = issues.map((s) => "- " + s).join("\n");
    if (attempt < MAX_SCHEMA_RETRIES) {
      log({
        module: "fanout",
        level: "warn",
        msg: "submit refused (schema)",
        fanoutID: record.fanoutID,
        workerSessionID: sessionID,
        name: record.name,
        attempt,
        issues,
      });
      return {
        content:
          "data does not satisfy the requested schema (attempt " +
          attempt +
          " of " +
          MAX_SCHEMA_RETRIES +
          "). Fix ALL of the following issues and call submit_result again with corrected data:\n" +
          issueList,
      };
    }
    record.submitted = true;
    if (record.schemaMode === "strict") {
      record.status = "failed";
      record.error = "schema_refused";
      record.validation = "missing";
      log({
        module: "fanout",
        level: "warn",
        msg: "submit refused finally (strict)",
        fanoutID: record.fanoutID,
        workerSessionID: sessionID,
        name: record.name,
        attempt,
      });
      return {
        content:
          "schema_refused: data failed schema validation " +
          MAX_SCHEMA_RETRIES +
          " times in strict mode. The result was discarded; the parent sees a failed task.\n" +
          issueList,
      };
    }
    record.status = "completed";
    record.data = record.lastData !== undefined ? record.lastData : null;
    record.validation = "invalid";
    log({
      module: "fanout",
      level: "warn",
      msg: "submit accepted finally (permissive, invalid)",
      fanoutID: record.fanoutID,
      workerSessionID: sessionID,
      name: record.name,
      attempt,
    });
    return {
      content:
        "accepted after " +
        MAX_SCHEMA_RETRIES +
        " failed validation attempts (permissive mode): the data is recorded but flagged invalid.\n" +
        issueList,
    };
  }

  async function extractFinalText(workerSessionID) {
    try {
      const messages = await ctx.session.context({ sessionID: workerSessionID });
      return finalAssistantText(messages);
    } catch {
      return null;
    }
  }

  // One task end to end: worktree -> worker session -> prompt -> wait ->
  // result extraction -> diffStat. Never rejects; every failure becomes a
  // result row with status "error" (or the appropriate terminal status).
  async function runTask({ rawTask, index, fanoutID, callerSessionID, locationDir, sharedContext }) {
    const task = rawTask && typeof rawTask === "object" ? rawTask : {};
    const name =
      typeof task.name === "string" && task.name.trim() ? task.name.trim() : "task";
    const agent =
      typeof task.agent === "string" && task.agent.trim() ? task.agent.trim() : cfg.defaultAgent;
    const taskText = typeof task.task === "string" ? task.task : "";
    const outputSchema =
      task.outputSchema && typeof task.outputSchema === "object" && !Array.isArray(task.outputSchema)
        ? task.outputSchema
        : null;
    const schemaMode = task.schemaMode === "strict" ? "strict" : "permissive";
    const timeoutMs = positiveNumber(task.timeoutMs) || cfg.defaultTimeoutMs;
    const worktree = worktreePathFor(fanoutID, index, name);

    const result = {
      name,
      agent,
      status: "error",
      validation: "missing",
      worktree,
      workerSessionID: "",
    };

    // 1. worktree (failures are per-task; siblings continue - all-settled)
    const created = await wt.createWorktree(locationDir, worktree);
    if (!created || !created.ok) {
      const stderr = created && created.stderr ? created.stderr : "git worktree add failed";
      result.error = "worktree creation failed: " + stderr;
      log({
        module: "fanout",
        level: "error",
        msg: "worktree-failed",
        fanoutID,
        index,
        name,
        worktree,
        error: result.error,
      });
      return result;
    }
    log({ module: "fanout", level: "info", msg: "worktree-created", fanoutID, index, name, worktree });

    // 2. worker session
    let workerSessionID = null;
    // Resolve the worker agent's pinned model first: agent-def model pins are
    // not applied automatically to plugin-created sessions (the service falls
    // back to its default model), so pass the agent's own model explicitly.
    // Best effort: if the lookup fails, create without an explicit model.
    let model;
    try {
      const agentInfo = await ctx.agent.get({ agentID: agent });
      if (agentInfo && agentInfo.data && agentInfo.data.model) model = agentInfo.data.model;
    } catch {
      // agent lookup unavailable - fall back to service-side resolution
    }
    try {
      const createdSession = await ctx.session.create({
        agent,
        ...(model ? { model } : {}),
        location: { directory: worktree },
        title: "fanout " + fanoutID + " " + name,
        metadata: { fusionTools: "fanout", fanoutID, taskName: name, parentSessionID: callerSessionID },
        permissions: workerPermissions(worktree),
      });
      workerSessionID = createdSession && createdSession.id ? createdSession.id : null;
    } catch (err) {
      result.error = "worker session creation failed: " + String(err);
      log({
        module: "fanout",
        level: "error",
        msg: "worker-session-failed",
        fanoutID,
        index,
        name,
        worktree,
        error: result.error,
      });
      return result;
    }
    if (!workerSessionID) {
      result.error = "worker session creation returned no id";
      log({
        module: "fanout",
        level: "error",
        msg: "worker-session-failed",
        fanoutID,
        index,
        name,
        worktree,
        error: result.error,
      });
      return result;
    }
    result.workerSessionID = workerSessionID;
    shared.ownCreated.add(workerSessionID);
    const record = {
      workerSessionID,
      fanoutID,
      name,
      agent,
      worktree,
      outputSchema,
      schemaMode,
      attempts: 0,
      submitted: false,
      lastData: undefined,
      data: undefined,
      error: null,
      validation: "missing",
      status: "error",
    };
    state.workers.set(workerSessionID, record);
    registrySet(record);
    log({
      module: "fanout",
      level: "info",
      msg: "worker-session-created",
      fanoutID,
      index,
      name,
      agent,
      workerSessionID,
      worktree,
    });

    // 3. prompt
    const promptText = composeWorkerPrompt({
      context: sharedContext,
      task: taskText,
      worktreePath: worktree,
      outputSchema,
    });
    try {
      await ctx.session.prompt({ sessionID: workerSessionID, text: promptText, delivery: "steer" });
    } catch (err) {
      result.error = "worker prompt failed: " + String(err);
      try {
        await ctx.session.interrupt({ sessionID: workerSessionID });
      } catch {
        // best effort
      }
      log({
        module: "fanout",
        level: "error",
        msg: "worker-prompt-failed",
        fanoutID,
        index,
        name,
        workerSessionID,
        error: result.error,
      });
      return result;
    }

    // 4. wait, raced against the per-task timeout
    const waitP = ctx.session
      .wait({ sessionID: workerSessionID })
      .then(() => "done")
      .catch(() => "done");
    const [timeoutP, cancelTimeout] = timeoutGate(timeoutMs);
    const outcome = await Promise.race([waitP, timeoutP]);
    cancelTimeout();

    if (outcome === "timeout") {
      try {
        await ctx.session.interrupt({ sessionID: workerSessionID });
      } catch {
        // best effort
      }
      log({
        module: "fanout",
        level: "warn",
        msg: "worker-timeout",
        fanoutID,
        index,
        name,
        workerSessionID,
        timeoutMs,
      });
      // Re-read from the cross-instance channel: a submit_result that landed
      // inside the race window (possibly from the worker's own plugin
      // generation) is honored even here.
      const latest = registryGetFresh(workerSessionID) || record;
      if (latest.submitted) {
        result.status = latest.status;
        result.validation = latest.validation;
        if (latest.data !== undefined) result.data = latest.data;
        if (latest.error) result.error = latest.error;
      } else {
        result.status = "timeout";
        result.error = "worker timed out after " + timeoutMs + "ms and was interrupted";
      }
    } else {
      // Re-read from the cross-instance channel: the worker's plugin
      // generation (separate module evaluation for the worktree's project)
      // records its submit_result in the shared state file, which this
      // generation's in-memory record does not see.
      const latest = registryGetFresh(workerSessionID) || record;
      if (latest.submitted) {
        // 5a. the worker reported through submit_result
        result.status = latest.status;
        result.validation = latest.validation;
        if (latest.data !== undefined) result.data = latest.data;
        if (latest.error) result.error = latest.error;
      } else {
        // 5b. no submit_result: fall back to the final assistant text
        const text = await extractFinalText(workerSessionID);
        if (text) {
          result.status = "completed";
          result.validation = "partial";
          result.data = text;
        } else {
          result.status = "failed";
          result.error = "no result: the worker never called submit_result and produced no assistant text";
        }
      }
    }

    // 6. diffStat (best effort)
    try {
      const ds = await wt.diffStat(worktree);
      if (ds) result.diffStat = ds;
    } catch {
      // best effort
    }

    return result;
  }

  const fanoutTool = {
    name: "fanout",
    description: FANOUT_DESCRIPTION,
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        context: {
          type: "string",
          description:
            "Optional shared context prepended to every worker prompt. Keep it short; each task description must still be self-contained.",
        },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: cfg.maxConcurrency,
          description:
            "Independent tasks to run in parallel. Each runs in its own git worktree with its own agent session.",
          items: FANOUT_TASK_ITEM_SCHEMA,
        },
      },
      required: ["tasks"],
    },
    execute: async (input, context) => {
      const agent = context && context.agent;
      const callerSessionID = context && context.sessionID;
      if (state.closing) {
        return { content: "fanout is shutting down; try again after the plugin reloads." };
      }
      if (isFusionToolsAgent(agent)) {
        log({
          module: "fanout",
          level: "info",
          msg: "fanout rejected (recursive)",
          agent: agent || null,
          callerSessionID: callerSessionID || null,
        });
        return {
          content:
            "fanout rejected: recursive fanout is disabled - fusion-tools agents (advisor/worker) cannot call fanout.",
        };
      }
      // Name-based gate bypass: a session whose agent has an arbitrary name
      // may still be a plugin-created worker. Refuse those by sessionID.
      const callerRecord = callerSessionID ? registryGet(callerSessionID) : null;
      if (callerRecord) {
        log({
          module: "fanout",
          level: "info",
          msg: "fanout rejected (worker session)",
          agent: agent || null,
          callerSessionID: callerSessionID || null,
        });
        return {
          content:
            "fanout rejected: worker sessions created by fanout cannot fan out again - report with submit_result; the parent integrates the worktrees.",
        };
      }
      const tasks = input && Array.isArray(input.tasks) ? input.tasks : null;
      if (!tasks || tasks.length === 0) {
        return { content: "fanout rejected: tasks must be a non-empty array." };
      }
      const capped = tasks.slice(0, cfg.maxConcurrency);

      // caller location (the worktrees are cut from that repo's HEAD)
      let locationDir = null;
      try {
        const info = await ctx.session.get({ sessionID: callerSessionID });
        locationDir =
          info && info.location && typeof info.location.directory === "string"
            ? info.location.directory
            : null;
      } catch (err) {
        log({
          module: "fanout",
          level: "warn",
          msg: "caller session lookup failed",
          callerSessionID: callerSessionID || null,
          error: String(err),
        });
      }
      if (!locationDir) {
        return {
          content: "fanout rejected: could not resolve the calling session's working directory.",
        };
      }
      const inRepo = await wt.isInsideGitRepo(locationDir);
      if (!inRepo) {
        log({
          module: "fanout",
          level: "info",
          msg: "fanout rejected (not a git repo)",
          callerSessionID,
          locationDir,
        });
        return {
          content:
            "fanout rejected: the calling session's location (" +
            locationDir +
            ") is not inside a git repository; fanout needs one to create worker worktrees.",
        };
      }

      const fanoutID = makeFanoutID();
      const startedAt = Date.now();
      const sharedContext = input && typeof input.context === "string" ? input.context : "";
      log({
        module: "fanout",
        level: "info",
        msg: "fanout-started",
        fanoutID,
        callerSessionID,
        locationDir,
        tasks: capped.length,
      });

      const settled = await Promise.allSettled(
        capped.map((rawTask, index) =>
          runTask({ rawTask, index, fanoutID, callerSessionID, locationDir, sharedContext }),
        ),
      );

      const results = settled.map((s, i) => {
        if (s.status === "fulfilled") return s.value;
        // runTask never rejects by design; a rejection here is a bug.
        log({
          module: "fanout",
          level: "error",
          msg: "task runner rejected",
          fanoutID,
          index: i,
          error: String(s.reason),
        });
        const raw = capped[i] || {};
        return {
          name: typeof raw.name === "string" && raw.name ? raw.name : "task",
          agent: typeof raw.agent === "string" && raw.agent ? raw.agent : cfg.defaultAgent,
          status: "error",
          error: String(s.reason),
          validation: "missing",
          worktree: worktreePathFor(fanoutID, i, raw.name),
          workerSessionID: "",
        };
      });

      // free the pending worker records for this run (both the generation's
      // own set and the cross-generation registry)
      for (const r of results) {
        if (r.workerSessionID) {
          state.workers.delete(r.workerSessionID);
          registryDelete(r.workerSessionID);
        }
      }

      const durationMs = Date.now() - startedAt;
      const fanoutRecord = {
        fanoutID,
        createdAt: new Date(startedAt).toISOString(),
        callerSessionID,
        locationDir,
        tasks: results.map((r) => ({
          name: r.name,
          worktree: r.worktree,
          workerSessionID: r.workerSessionID,
          status: r.status,
        })),
      };
      await storage.setJSON(STORAGE_PREFIX + fanoutID, fanoutRecord);

      const counts = {};
      for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
      log({
        module: "fanout",
        level: "info",
        msg: "fanout-completed",
        fanoutID,
        durationMs,
        tasks: results.length,
        statuses: counts,
      });

      const payload = { fanoutID, results, durationMs };
      let serialized;
      try {
        serialized = JSON.stringify(payload, null, 2);
      } catch {
        serialized = JSON.stringify({
          fanoutID,
          durationMs,
          results: results.map((r) => ({ ...r, data: undefined })),
        });
      }
      return { content: serialized, metadata: { fanoutID } };
    },
  };

  const submitResultTool = {
    name: "submit_result",
    description: SUBMIT_DESCRIPTION,
    // codemode: false -> expose as a DIRECT session tool (default plugin
    // tools are routed through Code Mode only and never reach a plain
    // session's function list - verified live in Phase 2).
    options: { codemode: false },
    input: SUBMIT_INPUT_SCHEMA,
    execute: async (input, context) => {
      const sessionID = context && context.sessionID;
      if (state.closing) {
        return { content: "submit_result refused: the fanout plugin is shutting down." };
      }
      const record = sessionID ? registryGet(sessionID) : null;
      if (!record) {
        log({
          module: "fanout",
          level: "info",
          msg: "submit refused (not a fanout worker)",
          sessionID: sessionID ? String(sessionID) : null,
        });
        return { content: "submit_result is only available to fanout workers." };
      }
      const data =
        input && typeof input === "object" && input.data !== undefined ? input.data : undefined;
      const error =
        input && typeof input === "object" && typeof input.error === "string" && input.error.trim()
          ? input.error.trim()
          : null;
      log({
        module: "fanout",
        level: "info",
        msg: "submit received",
        fanoutID: record.fanoutID,
        workerSessionID: sessionID,
        name: record.name,
        hasError: Boolean(error),
        hasData: data !== undefined,
      });

      if (record.submitted) {
        return { content: "result already submitted for this task." };
      }

      // worker-reported failure
      if (error) {
        record.submitted = true;
        record.status = "failed";
        record.error = error;
        record.validation = "missing";
        registrySet(record);
        log({
          module: "fanout",
          level: "info",
          msg: "submit accepted (error field)",
          fanoutID: record.fanoutID,
          workerSessionID: sessionID,
          name: record.name,
        });
        return { content: "error recorded; the parent will see the task as failed." };
      }

      if (data === undefined || data === null) {
        record.attempts += 1;
        record.lastData = undefined;
        const res = retryOrFinalize(record, sessionID, [
          data === undefined
            ? "data is required (it was missing)"
            : "data must be a non-null JSON value (it was null)",
        ]);
        registrySet(record);
        return res;
      }

      if (record.outputSchema) {
        const verdict = validateSchema(record.outputSchema, data);
        if (verdict.ok) {
          record.submitted = true;
          record.status = "completed";
          record.data = data;
          record.validation = "valid";
          registrySet(record);
          log({
            module: "fanout",
            level: "info",
            msg: "submit accepted",
            fanoutID: record.fanoutID,
            workerSessionID: sessionID,
            name: record.name,
            validation: "valid",
          });
          return { content: "result accepted." };
        }
        record.attempts += 1;
        record.lastData = data;
        const res = retryOrFinalize(record, sessionID, verdict.errors);
        registrySet(record);
        return res;
      }

      // no schema: any non-null JSON value is accepted
      record.submitted = true;
      record.status = "completed";
      record.data = data;
      record.validation = "valid";
      registrySet(record);
      log({
        module: "fanout",
        level: "info",
        msg: "submit accepted",
        fanoutID: record.fanoutID,
        workerSessionID: sessionID,
        name: record.name,
        validation: "valid",
      });
      return { content: "result accepted." };
    },
  };

  // True when the sessionID belongs to a plugin-created fanout worker
  // (in-memory fast path, file-backed cross-generation registry). The
  // context hook uses this to strip the fanout tool from worker sessions
  // even when the worker's agent name is not fusion-tools-shaped.
  function hasWorkerRecord(sessionID) {
    return Boolean(sessionID && registryGet(sessionID));
  }

  // Context-hook helper over the session's tools record (the seam where a
  // plugin tool becomes a DIRECT tool for a session):
  //  - the fanout tool is deleted for every fusion-tools agent AND for every
  //    plugin-created session (advisor sessions in the caller's ownCreated
  //    set; fanout workers via hasWorkerRecord) - the hook passes those in;
  //  - submit_result is injected for fanout workers (any non-advisor fusion
  //    agent) so they can report their results directly.
  // Never throws.
  function shapeSessionTools(input, agent) {
    try {
      if (!input || !input.tools || typeof input.tools !== "object") return;
      if (input.tools.fanout) delete input.tools.fanout;
      if (agent !== "advisor" && !input.tools.submit_result) {
        input.tools.submit_result = {
          description: SUBMIT_DESCRIPTION,
          input: SUBMIT_INPUT_SCHEMA,
        };
      }
    } catch {
      // never throw from a hook
    }
  }

  // Orphan sweep at setup: warn about recorded worktrees still on disk.
  // v1 never auto-deletes - integration data lives there.
  async function orphanSweep() {
    try {
      const stored = await storage.scanPrefix(STORAGE_PREFIX);
      const retained = [];
      for (const [, value] of stored) {
        if (!value || typeof value !== "object" || !Array.isArray(value.tasks)) continue;
        for (const t of value.tasks) {
          if (t && typeof t.worktree === "string" && t.worktree && existsSync(t.worktree)) {
            retained.push(t.worktree);
          }
        }
      }
      if (retained.length > 0) {
        log({
          module: "fanout",
          level: "warn",
          msg:
            "orphan sweep: worktrees from earlier fanout runs are still on disk (retained for integration; not auto-deleted)",
          count: retained.length,
          worktrees: retained.slice(0, 20),
        });
      }
      return retained;
    } catch (err) {
      log({
        module: "fanout",
        level: "warn",
        msg: "orphan sweep failed",
        error: String(err),
      });
      return [];
    }
  }

  async function cleanup() {
    state.closing = true;
    for (const [workerSessionID] of state.workers) {
      try {
        await ctx.session.interrupt({ sessionID: workerSessionID });
      } catch {
        // best effort
      }
      registryDelete(workerSessionID);
    }
    state.workers.clear();
    log({ module: "fanout", level: "info", msg: "fanout cleanup complete" });
  }

  return {
    tools: { fanout: fanoutTool, submitResult: submitResultTool },
    shapeSessionTools,
    hasWorkerRecord,
    orphanSweep,
    cleanup,
    state,
    config: { worktreeBase },
  };
}

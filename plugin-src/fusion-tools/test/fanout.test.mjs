// fusion-tools tests: fanout module (Phase 2).
//
// Drives the REAL plugin setup(ctx) against a mocked plugin context (same
// pattern as test/idle-review.test.mjs), with REAL git for the worktree
// paths: each test that runs a fanout creates a throwaway git repo and
// worktree base under /tmp/opencode and removes them afterwards.
//
// Covered: orchestration (all-settled, timeout+interrupt, results shape,
// storage record), submit_result flow (valid ack, invalid retry, permissive
// accept after 3, strict refuse, non-worker rejection, error field, double
// submit, non-object data), recursive-fanout and non-git-location guards,
// worker-session caller refusal, worker ruleset shape (path-scoped allows +
// explicit denies, per-worktree interpolation), worker prompt composition,
// context-hook fanout hiding (fusion agents AND plugin-created sessionIDs;
// orchestrator-only: untracked non-build/plan agents also lose fanout),
// the steer command, and the orphan sweep.
//
// Run: node --test plugin-src/fusion-tools/test/

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the plugin log: test runs must never append to the live state
// file (~/.local/state/opencode/fusion-tools.log). lib/log.js reads this
// env var lazily on every log()/logFile() call. The temp dir is removed
// after the suite finishes (top-level after hook).
const TEST_LOG_DIR = mkdtempSync(path.join(os.tmpdir(), "fusion-tools-test-log-"));
process.env.FUSION_TOOLS_LOG_FILE = path.join(TEST_LOG_DIR, "test.log");
after(() => {
  try {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

import plugin from "../index.js";
import { composeWorkerPrompt } from "../lib/workerprompt.js";
import { sanitizeTaskName, DEFAULT_WORKTREE_BASE } from "../lib/worktree.js";
import { finalAssistantText, STORAGE_PREFIX } from "../lib/fanout.js";
import { logFile } from "../lib/log.js";

const FILE_SCHEMA = {
  type: "object",
  properties: { file: { type: "string" } },
  required: ["file"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- helpers

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error("git " + args.join(" ") + ": " + String(stderr || err.message)));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

async function makeTempRoot() {
  return mkdtemp("/tmp/opencode/fanout-test-");
}

async function makeRepo(dir) {
  await mkdir(dir, { recursive: true });
  await git(["init"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  await git(["config", "user.name", "test"], dir);
  await git(["commit", "--allow-empty", "-m", "init"], dir);
}

function makeCtx(overrides = {}) {
  const hooks = { context: null };
  const tools = [];
  const commands = [];
  const calls = { creates: [], prompts: [], interrupts: [], waits: [] };
  const waitResolvers = new Map();
  const hangSessions = overrides.hangSessions || new Set();
  const storageMap = new Map();
  const fakeStorage = {
    get: async (key) => (storageMap.has(key) ? storageMap.get(key) : undefined),
    set: async (key, value) => {
      storageMap.set(key, value);
    },
    remove: async (key) => {
      storageMap.delete(key);
    },
    scan: async ({ prefix, after }) => {
      const entries = [...storageMap.entries()]
        .filter(([k]) => k.startsWith(prefix) && (!after || k > after))
        .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
        .map(([key, value]) => ({ key, value }));
      return { entries, next: null };
    },
  };
  let workerCounter = 0;
  const buffered = [];
  let notify = null;
  const stream = {
    push(ev) {
      if (notify) {
        const n = notify;
        notify = null;
        n({ value: ev, done: false });
      } else {
        buffered.push(ev);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (buffered.length) return Promise.resolve({ value: buffered.shift(), done: false });
          return new Promise((res) => {
            notify = res;
          });
        },
        return: async () => ({ value: undefined, done: true }),
      };
    },
  };
  const transcript =
    overrides.transcript ||
    (() => [
      {
        id: "m-assist",
        type: "assistant",
        agent: "worker",
        content: [{ type: "text", text: "task finished" }],
      },
    ]);

  const ctx = {
    options: {
      advisor: { enabled: true, scope: ["build", "plan"], reviewTimeoutMs: 50 },
      fanout: {
        enabled: true,
        maxConcurrency: 8,
        defaultAgent: "worker",
        defaultTimeoutMs: overrides.defaultTimeoutMs || 600000,
        worktreeBase: overrides.worktreeBase,
      },
    },
    storage: fakeStorage,
    event: { subscribe: () => stream },
    agent: {
      get: async ({ agentID }) =>
        overrides.agentModels && overrides.agentModels[agentID]
          ? { data: { id: agentID, model: overrides.agentModels[agentID] } }
          : { data: { id: agentID, model: undefined } },
    },
    session: {
      hook: async (name, fn) => {
        hooks[name] = fn;
        return { dispose: async () => {} };
      },
      get: async ({ sessionID }) => ({
        id: sessionID,
        location: { directory: overrides.repoDir || "/repo" },
      }),
      create: async (input) => {
        calls.creates.push(input);
        if (overrides.failAgents && overrides.failAgents.includes(input.agent)) {
          throw new Error("agent not found: " + input.agent);
        }
        workerCounter += 1;
        return { id: "worker-ses-" + workerCounter };
      },
      prompt: async (input) => {
        calls.prompts.push(input);
      },
      wait: async ({ sessionID }) => {
        calls.waits.push(sessionID);
        if (hangSessions.has(sessionID)) {
          return new Promise((resolve) => waitResolvers.set(sessionID, resolve));
        }
        return undefined;
      },
      interrupt: async (input) => {
        calls.interrupts.push(input.sessionID);
      },
      context: async ({ sessionID }) => transcript(sessionID),
      synthetic: async () => {},
    },
    tool: {
      transform: async (fn) => {
        fn({
          add: (t) => {
            tools.push(t);
          },
        });
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (fn) => {
        fn({
          add: (c) => {
            commands.push(c);
          },
        });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, hooks, tools, commands, calls, storageMap, waitResolvers };
}

function waitUntil(cond, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      try {
        if (cond()) return resolve();
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - t0 > ms) return reject(new Error("waitUntil timeout"));
      setTimeout(poll, 5);
    })();
  });
}

// Let every pending fire-and-forget chain settle before assertions.
const settle = () => new Promise((r) => setTimeout(r, 25));

async function readLog() {
  try {
    return await readFile(logFile(), "utf8");
  } catch {
    return "";
  }
}

async function lastLogLine(fragment) {
  const text = await readLog();
  const lines = text.split("\n").filter((l) => l.includes(fragment));
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------------ setup shape

test("setup registers fanout and submit_result tools alongside advise", async () => {
  const h = makeCtx();
  const cleanup = await plugin.setup(h.ctx);
  try {
    const names = h.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["advise", "fanout", "submit_result"]);
    const fanout = h.tools.find((t) => t.name === "fanout");
    assert.equal(fanout.input.properties.tasks.maxItems, 8, "maxItems = config maxConcurrency");
    assert.equal(fanout.input.properties.tasks.minItems, 1);
    assert.deepEqual(fanout.input.properties.tasks.items.required, ["task"]);
    assert.deepEqual(fanout.input.properties.tasks.items.properties.schemaMode.enum, [
      "permissive",
      "strict",
    ]);
    const submit = h.tools.find((t) => t.name === "submit_result");
    assert.ok(submit.input.properties.data);
    assert.ok(submit.input.properties.error);
    // the steer command registers alongside the tools (always-on module)
    assert.ok(h.commands.find((c) => c.name === "steer"), "steer command registered");
  } finally {
    await cleanup();
  }
  await settle();
});

test("fanout disabled (no options key) registers only advise", async () => {
  const h = makeCtx();
  delete h.ctx.options.fanout;
  const cleanup = await plugin.setup(h.ctx);
  try {
    assert.deepEqual(h.tools.map((t) => t.name), ["advise"]);
    assert.match(await readLog(), /"msg":"fanout disabled; registering nothing"/);
  } finally {
    await cleanup();
  }
  await settle();
});

// ------------------------------------------------------- orchestration

test("fanout happy path: real worktrees, submit results, diffStat, storage record", async () => {
  const root = await makeTempRoot();
  const repoDir = path.join(root, "repo");
  const wtBase = path.join(root, "wtbase");
  await makeRepo(repoDir);
  const h = makeCtx({
    repoDir,
    worktreeBase: wtBase,
    agentModels: { worker: { providerID: "opencode-go", id: "glm-5.3-flash" } },
    hangSessions: new Set(["worker-ses-1", "worker-ses-2"]),
  });
  const cleanup = await plugin.setup(h.ctx);
  try {
    const fanoutTool = h.tools.find((t) => t.name === "fanout");
    const submitTool = h.tools.find((t) => t.name === "submit_result");

    const fanoutP = fanoutTool.execute(
      {
        context: "parent context line",
        tasks: [
          { name: "Alpha File", task: "create a.txt containing A", outputSchema: FILE_SCHEMA },
          { name: "beta", task: "create b.txt containing B" },
        ],
      },
      { sessionID: "P1", agent: "build" },
    );
    await waitUntil(() => h.calls.prompts.length === 2);

    // worktrees really exist under the configured base
    const fanDirs = await readdir(wtBase);
    assert.equal(fanDirs.length, 1);
    const fanoutID = fanDirs[0];
    const taskDirs = (await readdir(path.join(wtBase, fanoutID))).sort();
    assert.deepEqual(taskDirs, ["0-alpha-file", "1-beta"]);

    // simulate the workers doing real work in their worktrees
    await writeFile(path.join(wtBase, fanoutID, "0-alpha-file", "a.txt"), "A");
    await writeFile(path.join(wtBase, fanoutID, "1-beta", "b.txt"), "B");

    // workers report through submit_result (task-to-session via prompt text)
    const alphaSession = h.calls.prompts.find((p) =>
      p.text.includes("create a.txt containing A"),
    ).sessionID;
    const betaSession = h.calls.prompts.find((p) =>
      p.text.includes("create b.txt containing B"),
    ).sessionID;
    const ack1 = await submitTool.execute({ data: { file: "a.txt" } }, { sessionID: alphaSession });
    const ack2 = await submitTool.execute({ data: { file: "b.txt" } }, { sessionID: betaSession });
    assert.equal(ack1.content, "result accepted.");
    assert.equal(ack2.content, "result accepted.");

    h.waitResolvers.get(alphaSession)();
    h.waitResolvers.get(betaSession)();
    const raw = await fanoutP;
    const payload = JSON.parse(raw.content);

    assert.match(payload.fanoutID, /^fo_\d+-[0-9a-f]{4}$/);
    assert.equal(typeof payload.durationMs, "number");
    assert.equal(payload.results.length, 2);

    const r0 = payload.results[0]; // results are in task order
    assert.equal(r0.name, "Alpha File");
    assert.equal(r0.agent, "worker");
    assert.equal(r0.status, "completed");
    assert.equal(r0.validation, "valid");
    assert.deepEqual(r0.data, { file: "a.txt" });
    assert.match(r0.worktree, /0-alpha-file$/);
    assert.match(r0.diffStat, /a\.txt/);
    assert.ok(r0.workerSessionID.startsWith("worker-ses-"));
    assert.equal(r0.error, undefined);

    const r1 = payload.results[1];
    assert.equal(r1.status, "completed");
    assert.equal(r1.validation, "valid");
    assert.deepEqual(r1.data, { file: "b.txt" });
    assert.match(r1.worktree, /1-beta$/);
    assert.match(r1.diffStat, /b\.txt/);

    // worker session create call carries agent, location, title, metadata, permissions
    const create = h.calls.creates.find((c) => c.metadata && c.metadata.taskName === "Alpha File");
    assert.equal(create.agent, "worker");
    assert.deepEqual(create.model, { providerID: "opencode-go", id: "glm-5.3-flash" }, "agent-pinned model passed explicitly");
    assert.equal(create.location.directory, r0.worktree);
    assert.match(create.title, /^fanout fo_/);
    assert.equal(create.metadata.fusionTools, "fanout");
    assert.equal(create.metadata.fanoutID, payload.fanoutID);
    assert.equal(create.metadata.parentSessionID, "P1");
    const perms = create.permissions;
    const wtBaseNorm = r0.worktree.replace(/\/+$/, "");
    // v2 resolves with findLast (last matching rule wins), so the catch-all
    // deny sits FIRST as the fallback that every later specific rule can
    // override; putting it last would deny everything below it.
    assert.equal(perms[0].action, "*");
    assert.equal(perms[0].resource, "*");
    assert.equal(perms[0].effect, "deny", "catch-all deny first (later rules override it)");
    // explicit denies: shell/exec-style actions and subagent spawning are
    // never re-allowed; edit/write are denied everywhere except the worktree
    for (const action of ["shell", "bash", "execute", "subagent", "edit", "write"]) {
      assert.ok(
        perms.some((p) => p.action === action && p.resource === "*" && p.effect === "deny") ||
          perms.some((p) => p.action === action && p.resource === "**" && p.effect === "deny"),
        action + " has an explicit deny",
      );
    }
    // read-family + submit_result allows
    assert.ok(perms.some((p) => p.action === "read" && p.resource === "*" && p.effect === "allow"));
    assert.ok(perms.some((p) => p.action === "grep" && p.resource === "*" && p.effect === "allow"));
    assert.ok(perms.some((p) => p.action === "glob" && p.resource === "*" && p.effect === "allow"));
    assert.ok(perms.some((p) => p.action === "submit_result" && p.resource === "*" && p.effect === "allow"));
    assert.ok(perms.some((p) => p.action === "read" && p.resource === "*.env" && p.effect === "ask"));
    assert.ok(perms.some((p) => p.action === "read" && p.resource === "*.env.*" && p.effect === "ask"));
    // the ONLY edit/write allows are path-scoped to this worker's worktree
    assert.deepEqual(
      perms.filter((p) => p.action === "edit" && p.effect === "allow").map((p) => p.resource),
      [wtBaseNorm + "/**"],
    );
    assert.deepEqual(
      perms.filter((p) => p.action === "write" && p.effect === "allow").map((p) => p.resource),
      [wtBaseNorm + "/**"],
    );
    // the worktree-scoped write allow is the trailing rule (it wins conflicts)
    assert.equal(perms[perms.length - 1].action, "write");
    assert.equal(perms[perms.length - 1].resource, wtBaseNorm + "/**");
    assert.equal(perms[perms.length - 1].effect, "allow");
    // per-worktree interpolation: beta's ruleset points at beta's worktree only
    const createBeta = h.calls.creates.find((c) => c.metadata && c.metadata.taskName === "beta");
    const betaBase = createBeta.location.directory.replace(/\/+$/, "");
    const betaWrite = createBeta.permissions[createBeta.permissions.length - 1];
    assert.equal(betaWrite.resource, betaBase + "/**");
    assert.ok(
      !createBeta.permissions.some((p) => p.resource === wtBaseNorm + "/**"),
      "beta cannot write alpha's worktree",
    );

    // worker prompt carries task, shared context, schema, working directory
    const prompt = h.calls.prompts.find((p) => p.sessionID === r0.workerSessionID);
    assert.equal(prompt.delivery, "steer");
    assert.match(prompt.text, /create a\.txt containing A/);
    assert.match(prompt.text, /parent context line/);
    assert.match(prompt.text, /"required"/);
    assert.match(prompt.text, new RegExp(escapeRegExp(r0.worktree)));
    const betaPrompt = h.calls.prompts.find((p) => p.sessionID === r1.workerSessionID);
    assert.match(betaPrompt.text, /no schema was given/);
    // storage record for the completed run
    const record = h.storageMap.get(STORAGE_PREFIX + payload.fanoutID);
    assert.ok(record, "fanout record persisted");
    assert.equal(record.fanoutID, payload.fanoutID);
    assert.equal(record.callerSessionID, "P1");
    assert.equal(record.locationDir, repoDir);
    assert.ok(record.createdAt);
    assert.deepEqual(
      record.tasks.map((t) => t.name).sort(),
      ["Alpha File", "beta"],
    );
    for (const t of record.tasks) {
      assert.ok(t.worktree);
      assert.ok(t.workerSessionID);
      assert.equal(t.status, "completed");
    }

    // log trail: worktree-created -> worker-session-created -> submit ack -> fanout-completed
    const logText = await readLog();
    assert.match(logText, new RegExp('"msg":"fanout-started".*"fanoutID":"' + fanoutID));
    assert.match(logText, /"msg":"worktree-created"/);
    assert.match(logText, /"msg":"worker-session-created"/);
    assert.match(logText, /"msg":"submit accepted"/);
    assert.match(logText, new RegExp('"msg":"fanout-completed".*"fanoutID":"' + fanoutID));
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
  await settle();
});

test("all-settled: a failed worker session does not cancel siblings", async () => {
  const root = await makeTempRoot();
  const repoDir = path.join(root, "repo");
  const wtBase = path.join(root, "wtbase");
  await makeRepo(repoDir);
  const h = makeCtx({ repoDir, worktreeBase: wtBase, failAgents: ["boom-agent"] });
  const cleanup = await plugin.setup(h.ctx);
  try {
    const fanoutTool = h.tools.find((t) => t.name === "fanout");
    const raw = await fanoutTool.execute(
      {
        tasks: [
          { name: "good", task: "do the good thing" },
          { name: "bad", task: "do the bad thing", agent: "boom-agent" },
        ],
      },
      { sessionID: "P1", agent: "build" },
    );
    const payload = JSON.parse(raw.content);
    assert.equal(payload.results.length, 2);
    assert.equal(payload.results[0].status, "completed");
    assert.equal(payload.results[0].validation, "partial", "transcript fallback");
    assert.equal(payload.results[0].data, "task finished");
    assert.equal(payload.results[1].status, "error");
    assert.match(payload.results[1].error, /worker session creation failed/);
    assert.equal(payload.results[1].workerSessionID, "");
    assert.equal(payload.results[1].validation, "missing");
    // only the sibling got a worker session and a prompt
    assert.equal(h.calls.prompts.length, 1);
    const record = h.storageMap.get(STORAGE_PREFIX + payload.fanoutID);
    assert.deepEqual(
      record.tasks.map((t) => t.status).sort(),
      ["completed", "error"],
    );
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
  await settle();
});

test("module-level: worktree failure for one task leaves the sibling running", async () => {
  const h = makeCtx({ defaultTimeoutMs: 5000 });
  const cleanup = await plugin.setup(h.ctx);
  try {
    // Drive the real module factory directly with an injected worktree stub
    // so the per-task failure branch is deterministic (no git needed here).
    const { createFanoutModule } = await import("../lib/fanout.js");
    const { createStorageAdapter } = await import("../lib/state.js");
    const realWorktree = await import("../lib/worktree.js");
    const mod = createFanoutModule({
      ctx: h.ctx,
      cfg: {
        enabled: true,
        maxConcurrency: 8,
        defaultAgent: "worker",
        defaultTimeoutMs: 5000,
        worktreeBase: "/wt-base",
      },
      storage: createStorageAdapter(h.ctx.storage),
      shared: { ownCreated: new Set() },
      deps: {
        worktree: {
          resolveWorktreeBase: (c) => c || "/wt-base",
          sanitizeTaskName: realWorktree.sanitizeTaskName,
          isInsideGitRepo: async () => true,
          createWorktree: async (repoDir, worktreePath) =>
            path.basename(worktreePath).startsWith("1-")
              ? { ok: false, stderr: "fatal: cannot lock ref" }
              : { ok: true, stderr: "" },
          diffStat: async () => null,
        },
      },
    });
    const res = await mod.tools.fanout.execute(
      { tasks: [{ name: "good", task: "g" }, { name: "bad", task: "b" }] },
      { sessionID: "P1", agent: "build" },
    );
    const payload = JSON.parse(res.content);
    assert.equal(payload.results[0].status, "completed");
    assert.equal(payload.results[1].status, "error");
    assert.match(payload.results[1].error, /worktree creation failed: fatal: cannot lock ref/);
    assert.equal(payload.results[1].workerSessionID, "");
    assert.equal(payload.results[1].validation, "missing");
    // only the sibling got a worker session and a prompt
    assert.equal(
      h.calls.creates.filter((c) => c.metadata && c.metadata.fusionTools === "fanout").length,
      1,
    );
    assert.equal(h.calls.prompts.length, 1);
  } finally {
    await cleanup();
  }
  await settle();
});

test("timeout: the worker is interrupted and the task is marked timeout", async () => {
  const root = await makeTempRoot();
  const repoDir = path.join(root, "repo");
  const wtBase = path.join(root, "wtbase");
  await makeRepo(repoDir);
  const h = makeCtx({
    repoDir,
    worktreeBase: wtBase,
    hangSessions: new Set(["worker-ses-1"]),
    defaultTimeoutMs: 40,
    transcript: () => [],
  });
  const cleanup = await plugin.setup(h.ctx);
  try {
    const fanoutTool = h.tools.find((t) => t.name === "fanout");
    const submitTool = h.tools.find((t) => t.name === "submit_result");
    const raw = await fanoutTool.execute(
      { tasks: [{ name: "slow", task: "never finishes" }] },
      { sessionID: "P1", agent: "build" },
    );
    const payload = JSON.parse(raw.content);
    assert.equal(payload.results[0].status, "timeout");
    assert.match(payload.results[0].error, /timed out after 40ms/);
    assert.equal(payload.results[0].validation, "missing");
    assert.deepEqual(h.calls.interrupts, ["worker-ses-1"]);
    assert.match(await readLog(), /"msg":"worker-timeout"/);
    // the pending worker record was freed after completion
    const late = await submitTool.execute({ data: {} }, { sessionID: "worker-ses-1" });
    assert.equal(late.content, "submit_result is only available to fanout workers.");
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
  await settle();
});

test("recursive fanout rejected for fusion-tools agents (worker and advisor)", async () => {
  const h = makeCtx();
  const cleanup = await plugin.setup(h.ctx);
  try {
    const fanoutTool = h.tools.find((t) => t.name === "fanout");
    for (const agent of ["worker", "advisor"]) {
      const res = await fanoutTool.execute(
        { tasks: [{ task: "x" }] },
        { sessionID: "P1", agent },
      );
      assert.match(res.content, /recursive fanout is disabled/);
    }
    assert.equal(h.calls.creates.length, 0);
    assert.equal(h.calls.prompts.length, 0);
  } finally {
    await cleanup();
  }
  await settle();
});

test("worker ruleset shape: scoped allows + explicit denies, interpolated per worktree", async () => {
  const root = await makeTempRoot();
  const repoDir = path.join(root, "repo");
  const wtBase = path.join(root, "wtbase");
  await makeRepo(repoDir);
  const h = makeCtx({ repoDir, worktreeBase: wtBase, defaultTimeoutMs: 40, transcript: () => [] });
  const cleanup = await plugin.setup(h.ctx);
  try {
    const fanoutTool = h.tools.find((t) => t.name === "fanout");
    // The run times out quickly; only the create-call permissions matter here.
    await fanoutTool.execute(
      { tasks: [{ name: "One", task: "t1" }, { name: "Two", task: "t2" }] },
      { sessionID: "P1", agent: "build" },
    );
    assert.equal(h.calls.creates.length, 2);
    for (const c of h.calls.creates) {
      const perms = c.permissions;
      const base = c.location.directory.replace(/\/+$/, "");
      assert.equal(perms[0].action, "*");
      assert.equal(perms[0].effect, "deny", "catch-all deny first");
      assert.ok(perms.some((p) => p.action === "subagent" && p.resource === "*" && p.effect === "deny"));
      assert.ok(perms.some((p) => p.action === "edit" && p.resource === "**" && p.effect === "deny"));
      assert.ok(perms.some((p) => p.action === "write" && p.resource === "**" && p.effect === "deny"));
      assert.ok(perms.some((p) => p.action === "read" && p.resource === "*" && p.effect === "allow"));
      assert.ok(perms.some((p) => p.action === "grep" && p.resource === "*" && p.effect === "allow"));
      assert.ok(perms.some((p) => p.action === "glob" && p.resource === "*" && p.effect === "allow"));
      assert.ok(perms.some((p) => p.action === "submit_result" && p.resource === "*" && p.effect === "allow"));
      // the ONLY edit/write allows are scoped to this worker's own worktree
      assert.deepEqual(
        perms.filter((p) => p.action === "edit" && p.effect === "allow").map((p) => p.resource),
        [base + "/**"],
      );
      assert.deepEqual(
        perms.filter((p) => p.action === "write" && p.effect === "allow").map((p) => p.resource),
        [base + "/**"],
      );
      // shell/exec-style actions are never re-allowed
      assert.ok(
        !perms.some(
          (p) =>
            (p.action === "shell" || p.action === "bash" || p.action === "execute") &&
            p.effect !== "deny",
        ),
      );
    }
    const [c0, c1] = h.calls.creates;
    assert.notEqual(
      c0.permissions[c0.permissions.length - 1].resource,
      c1.permissions[c1.permissions.length - 1].resource,
      "each worker's trailing write allow interpolates its own worktree",
    );
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
  await settle();
});

test("fanout refuses calls from a plugin-created worker session (registry gate)", async () => {
  const root = await makeTempRoot();
  const repoDir = path.join(root, "repo");
  const wtBase = path.join(root, "wtbase");
  await makeRepo(repoDir);
  const h = makeCtx({ repoDir, worktreeBase: wtBase, hangSessions: new Set(["worker-ses-1"]) });
  const cleanup = await plugin.setup(h.ctx);
  try {
    const fanoutTool = h.tools.find((t) => t.name === "fanout");
    const runP = fanoutTool.execute(
      { tasks: [{ name: "alpha", task: "do alpha" }] },
      { sessionID: "P1", agent: "build" },
    );
    await waitUntil(() => h.calls.prompts.length === 1);
    // The worker session calls fanout again; the agent name ("build") is a
    // red herring - the registry gate keys on the caller sessionID.
    const res = await fanoutTool.execute(
      { tasks: [{ task: "nested" }] },
      { sessionID: "worker-ses-1", agent: "build" },
    );
    assert.match(res.content, /worker sessions created by fanout cannot fan out again/);
    assert.match(res.content, /report with submit_result/);
    assert.equal(h.calls.creates.length, 1, "no new worker session was created");
    h.waitResolvers.get("worker-ses-1")();
    await runP;
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
  await settle();
});

test("context hook strips fanout for plugin-created sessionIDs regardless of agent name", async () => {
  const root = await makeTempRoot();
  const repoDir = path.join(root, "repo");
  const wtBase = path.join(root, "wtbase");
  await makeRepo(repoDir);
  const h = makeCtx({ repoDir, worktreeBase: wtBase, hangSessions: new Set(["worker-ses-1"]) });
  const cleanup = await plugin.setup(h.ctx);
  try {
    assert.ok(h.hooks.context, "context hook registered");
    const fanoutTool = h.tools.find((t) => t.name === "fanout");
    const runP = fanoutTool.execute(
      { tasks: [{ name: "alpha", task: "do alpha" }] },
      { sessionID: "P1", agent: "build" },
    );
    await waitUntil(() => h.calls.prompts.length === 1);
    // plugin-created worker session, non-fusion agent name: fanout is
    // stripped by sessionID, submit_result is injected.
    const workerInput = {
      agent: "build",
      sessionID: "worker-ses-1",
      tools: { fanout: { d: 1 }, read: { d: 2 } },
    };
    h.hooks.context(workerInput);
    assert.equal(workerInput.tools.fanout, undefined, "fanout stripped by sessionID");
    assert.ok(workerInput.tools.submit_result, "worker keeps submit_result");
    assert.ok(workerInput.tools.read, "other tools untouched");
    // a plain (non-plugin-created) session with the same agent keeps fanout
    const plain = { agent: "build", sessionID: "P1", tools: { fanout: { d: 1 } } };
    h.hooks.context(plain);
    assert.ok(plain.tools.fanout, "caller session keeps fanout");
    h.waitResolvers.get("worker-ses-1")();
    await runP;
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
  await settle();
});

test("submit_result accepts non-object data when the schema permits it", async () => {
  const root = await makeTempRoot();
  const repoDir = path.join(root, "repo");
  const wtBase = path.join(root, "wtbase");
  await makeRepo(repoDir);
  const h = makeCtx({
    repoDir,
    worktreeBase: wtBase,
    hangSessions: new Set(["worker-ses-1", "worker-ses-2"]),
    defaultTimeoutMs: 30000,
  });
  const cleanup = await plugin.setup(h.ctx);
  try {
    const fanoutTool = h.tools.find((t) => t.name === "fanout");
    const submitTool = h.tools.find((t) => t.name === "submit_result");
    const runP = fanoutTool.execute(
      {
        tasks: [
          { name: "free", task: "t1" },
          { name: "str", task: "t2", outputSchema: { type: "string" } },
        ],
      },
      { sessionID: "P1", agent: "build" },
    );
    await waitUntil(() => h.calls.prompts.length === 2);
    const freeSession = h.calls.prompts.find((p) => p.text.includes("t1")).sessionID;
    const strSession = h.calls.prompts.find((p) => p.text.includes("t2")).sessionID;
    // no schema: any non-null JSON value - here a plain string
    const ack1 = await submitTool.execute({ data: "just a string" }, { sessionID: freeSession });
    assert.equal(ack1.content, "result accepted.");
    // null stays refused even without a schema
    const ackNull = await submitTool.execute({ data: null }, { sessionID: strSession });
    assert.match(ackNull.content, /data must be a non-null JSON value/);
    // string schema: non-object data that satisfies the schema
    const ack2 = await submitTool.execute({ data: "hello" }, { sessionID: strSession });
    assert.equal(ack2.content, "result accepted.");
    h.waitResolvers.get(freeSession)();
    h.waitResolvers.get(strSession)();
    const payload = JSON.parse((await runP).content);
    assert.equal(payload.results[0].status, "completed");
    assert.equal(payload.results[0].validation, "valid");
    assert.equal(payload.results[0].data, "just a string");
    assert.equal(payload.results[1].status, "completed");
    assert.equal(payload.results[1].validation, "valid");
    assert.equal(payload.results[1].data, "hello");
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
  await settle();
});

test("fanout rejected when the caller location is not a git repo", async () => {
  const outside = await makeTempRoot(); // real dir, deliberately not a repo
  const h = makeCtx({ repoDir: outside });
  const cleanup = await plugin.setup(h.ctx);
  try {
    const fanoutTool = h.tools.find((t) => t.name === "fanout");
    const res = await fanoutTool.execute(
      { tasks: [{ task: "x" }] },
      { sessionID: "P1", agent: "build" },
    );
    assert.match(res.content, /not inside a git repository/);
    assert.equal(h.calls.creates.length, 0);
    assert.match(await readLog(), /"msg":"fanout rejected \(not a git repo\)"/);
  } finally {
    await cleanup();
    await rm(outside, { recursive: true, force: true });
  }
  await settle();
});

// ------------------------------------------------------- submit_result

async function submitFixture({ schemaMode, hang = true } = {}) {
  const root = await makeTempRoot();
  const repoDir = path.join(root, "repo");
  const wtBase = path.join(root, "wtbase");
  await makeRepo(repoDir);
  const h = makeCtx({
    repoDir,
    worktreeBase: wtBase,
    // generous enough to never fire in a passing run; short enough that a
    // mid-test failure cannot park a 600s timer in the test runner
    defaultTimeoutMs: 30000,
    hangSessions: hang ? new Set(["worker-ses-1"]) : new Set(),
  });
  const cleanup = await plugin.setup(h.ctx);
  const fanoutTool = h.tools.find((x) => x.name === "fanout");
  const submitTool = h.tools.find((x) => x.name === "submit_result");
  const task = {
    name: "alpha",
    task: "do alpha",
    outputSchema: FILE_SCHEMA,
    schemaMode,
  };
  const fanoutP = fanoutTool.execute({ tasks: [task] }, { sessionID: "P1", agent: "build" });
  await waitUntil(() => h.calls.prompts.length === 1);
  const release = () => {
    const r = h.waitResolvers.get("worker-ses-1");
    if (r) r();
  };
  return { root, cleanup, h, submitTool, fanoutP, release };
}

test("submit_result: valid data is accepted and lands in the result row", async () => {
  const fx = await submitFixture();
  try {
    const ack = await fx.submitTool.execute({ data: { file: "a.txt" } }, { sessionID: "worker-ses-1" });
    assert.equal(ack.content, "result accepted.");
    fx.release();
    const payload = JSON.parse((await fx.fanoutP).content);
    assert.equal(payload.results[0].status, "completed");
    assert.equal(payload.results[0].validation, "valid");
    assert.deepEqual(payload.results[0].data, { file: "a.txt" });
  } finally {
    await fx.cleanup();
    await rm(fx.root, { recursive: true, force: true });
  }
  await settle();
});

test("submit_result: invalid data returns a retry error listing ALL issues", async () => {
  const fx = await submitFixture();
  try {
    const ack = await fx.submitTool.execute({ data: { nope: 1 } }, { sessionID: "worker-ses-1" });
    assert.match(ack.content, /attempt 1 of 3/);
    assert.match(ack.content, /data\.file: required property is missing/);
    assert.match(ack.content, /data\.nope: unexpected property/);
    // then a valid retry goes through
    const ack2 = await fx.submitTool.execute({ data: { file: "a.txt" } }, { sessionID: "worker-ses-1" });
    assert.equal(ack2.content, "result accepted.");
    fx.release();
    const payload = JSON.parse((await fx.fanoutP).content);
    assert.equal(payload.results[0].validation, "valid");
  } finally {
    await fx.cleanup();
    await rm(fx.root, { recursive: true, force: true });
  }
  await settle();
});

test("submit_result: permissive mode accepts after 3 failed attempts and flags invalid", async () => {
  const fx = await submitFixture({ schemaMode: "permissive" });
  try {
    const a1 = await fx.submitTool.execute({ data: { bad: 1 } }, { sessionID: "worker-ses-1" });
    assert.match(a1.content, /attempt 1 of 3/);
    const a2 = await fx.submitTool.execute({ data: { bad: 2 } }, { sessionID: "worker-ses-1" });
    assert.match(a2.content, /attempt 2 of 3/);
    const a3 = await fx.submitTool.execute({ data: { bad: 3 } }, { sessionID: "worker-ses-1" });
    assert.match(a3.content, /accepted after 3 failed validation attempts \(permissive mode\)/);
    assert.match(a3.content, /flagged invalid/);
    fx.release();
    const payload = JSON.parse((await fx.fanoutP).content);
    assert.equal(payload.results[0].status, "completed");
    assert.equal(payload.results[0].validation, "invalid");
    assert.deepEqual(payload.results[0].data, { bad: 3 }, "last attempted data is kept");
  } finally {
    await fx.cleanup();
    await rm(fx.root, { recursive: true, force: true });
  }
  await settle();
});

test("submit_result: strict mode refuses after 3 failed attempts (schema_refused)", async () => {
  const fx = await submitFixture({ schemaMode: "strict" });
  try {
    const a1 = await fx.submitTool.execute({ data: { bad: 1 } }, { sessionID: "worker-ses-1" });
    assert.match(a1.content, /attempt 1 of 3/);
    const a2 = await fx.submitTool.execute({ data: { bad: 2 } }, { sessionID: "worker-ses-1" });
    assert.match(a2.content, /attempt 2 of 3/);
    const a3 = await fx.submitTool.execute({ data: { bad: 3 } }, { sessionID: "worker-ses-1" });
    assert.match(a3.content, /schema_refused/);
    fx.release();
    const payload = JSON.parse((await fx.fanoutP).content);
    assert.equal(payload.results[0].status, "failed");
    assert.equal(payload.results[0].error, "schema_refused");
    assert.equal(payload.results[0].validation, "missing");
    assert.equal(payload.results[0].data, undefined);
  } finally {
    await fx.cleanup();
    await rm(fx.root, { recursive: true, force: true });
  }
  await settle();
});

test("submit_result: non-worker sessions are rejected", async () => {
  const h = makeCtx();
  const cleanup = await plugin.setup(h.ctx);
  try {
    const submitTool = h.tools.find((x) => x.name === "submit_result");
    for (const sessionID of ["P-primary", "advisor-ses-9", ""]) {
      const res = await submitTool.execute({ data: { x: 1 } }, { sessionID });
      assert.equal(res.content, "submit_result is only available to fanout workers.");
    }
  } finally {
    await cleanup();
  }
  await settle();
});

test("submit_result: the error field records a failed task", async () => {
  const fx = await submitFixture();
  try {
    const ack = await fx.submitTool.execute(
      { error: "blocked by missing credentials" },
      { sessionID: "worker-ses-1" },
    );
    assert.match(ack.content, /error recorded/);
    fx.release();
    const payload = JSON.parse((await fx.fanoutP).content);
    assert.equal(payload.results[0].status, "failed");
    assert.equal(payload.results[0].error, "blocked by missing credentials");
    assert.equal(payload.results[0].validation, "missing");
    assert.equal(payload.results[0].data, undefined);
  } finally {
    await fx.cleanup();
    await rm(fx.root, { recursive: true, force: true });
  }
  await settle();
});

test("submit_result: a second submit after acceptance is refused", async () => {
  const fx = await submitFixture();
  try {
    const a1 = await fx.submitTool.execute({ data: { file: "a.txt" } }, { sessionID: "worker-ses-1" });
    assert.equal(a1.content, "result accepted.");
    const a2 = await fx.submitTool.execute({ data: { file: "other.txt" } }, { sessionID: "worker-ses-1" });
    assert.equal(a2.content, "result already submitted for this task.");
    fx.release();
    const payload = JSON.parse((await fx.fanoutP).content);
    assert.deepEqual(payload.results[0].data, { file: "a.txt" }, "first result stands");
  } finally {
    await fx.cleanup();
    await rm(fx.root, { recursive: true, force: true });
  }
  await settle();
});

// --------------------------------------------- context hook + orphan sweep

test("context hook shapes fusion-agent tools: hides fanout, injects submit_result", async () => {
  const h = makeCtx();
  const cleanup = await plugin.setup(h.ctx);
  try {
    assert.ok(h.hooks.context, "context hook registered");
    const workerInput = {
      agent: "worker",
      sessionID: "w1",
      tools: { fanout: { d: 1 }, read: { d: 3 } },
    };
    h.hooks.context(workerInput);
    assert.equal(workerInput.tools.fanout, undefined, "fanout deleted for workers");
    assert.ok(workerInput.tools.submit_result, "submit_result injected for workers");
    assert.ok(workerInput.tools.submit_result.description);
    assert.ok(workerInput.tools.read, "other tools untouched");

    const workerWithSubmit = {
      agent: "worker",
      sessionID: "w1b",
      tools: { fanout: { d: 1 }, submit_result: { d: 2, custom: true } },
    };
    h.hooks.context(workerWithSubmit);
    assert.equal(workerWithSubmit.tools.fanout, undefined);
    assert.equal(workerWithSubmit.tools.submit_result.d, 2, "existing submit_result kept");

    const advisorInput = {
      agent: "advisor",
      sessionID: "a1",
      tools: { fanout: { d: 1 } },
    };
    h.hooks.context(advisorInput);
    assert.equal(advisorInput.tools.fanout, undefined, "fanout deleted for advisor");
    assert.equal(advisorInput.tools.submit_result, undefined, "advisor gets no submit_result");

    const otherInput = { agent: "sidekick", sessionID: "s1", tools: { fanout: { d: 1 } } };
    h.hooks.context(otherInput);
    assert.equal(otherInput.tools.fanout, undefined, "fanout stripped for non-orchestrator agents");

    // inputs without a tools record never throw
    h.hooks.context({ agent: "worker", sessionID: "w2" });
  } finally {
    await cleanup();
  }
  await settle();
});

test("fanout is orchestrator-only: stripped for sidekick, kept for build/plan", async () => {
  const h = makeCtx();
  const cleanup = await plugin.setup(h.ctx);
  try {
    assert.ok(h.hooks.context, "context hook registered");
    // a plain non-orchestrator agent never sees the fanout tool
    const sidekick = {
      agent: "sidekick",
      sessionID: "S1",
      tools: { fanout: { d: 1 }, read: { d: 2 } },
    };
    h.hooks.context(sidekick);
    assert.equal(sidekick.tools.fanout, undefined, "fanout stripped for sidekick");
    assert.ok(sidekick.tools.read, "other tools untouched");
    assert.equal(
      sidekick.tools.submit_result,
      undefined,
      "no submit_result injection for plain agents",
    );
    // the orchestrator primaries keep it
    const build = { agent: "build", sessionID: "P1", tools: { fanout: { d: 1 } } };
    h.hooks.context(build);
    assert.ok(build.tools.fanout, "build keeps fanout");
    const plan = { agent: "plan", sessionID: "P2", tools: { fanout: { d: 1 } } };
    h.hooks.context(plan);
    assert.ok(plan.tools.fanout, "plan keeps fanout");
    // inputs without a tools record never throw
    h.hooks.context({ agent: "sidekick", sessionID: "S3" });
  } finally {
    await cleanup();
  }
  await settle();
});

test("orphan sweep warns once for recorded worktrees that still exist", async () => {
  const root = await makeTempRoot();
  const retainedDir = path.join(root, "kept-worktree");
  await (await import("node:fs/promises")).mkdir(retainedDir, { recursive: true });
  const h = makeCtx();
  h.storageMap.set(STORAGE_PREFIX + "fo_seed", {
    fanoutID: "fo_seed",
    createdAt: new Date().toISOString(),
    callerSessionID: "P-old",
    locationDir: "/old",
    tasks: [
      { name: "alpha", worktree: retainedDir, workerSessionID: "w1", status: "completed" },
      { name: "ghost", worktree: "/definitely/not/there", workerSessionID: "w2", status: "completed" },
    ],
  });
  const cleanup = await plugin.setup(h.ctx);
  try {
    const line = await lastLogLine("orphan sweep");
    assert.ok(line, "orphan sweep warning logged");
    assert.equal(line.level, "warn");
    assert.equal(line.count, 1, "only the existing worktree is reported");
    assert.deepEqual(line.worktrees, [retainedDir]);
    assert.equal(existsSync(retainedDir), true, "sweep never auto-deletes");
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
  await settle();
});

// --------------------------------------------------------- pure helpers

test("composeWorkerPrompt contains context, task, dir, schema and rules", () => {
  const schema = { type: "object", properties: { file: { type: "string" } }, required: ["file"] };
  const text = composeWorkerPrompt({
    context: "the parent says hi",
    task: "create a.txt containing A",
    worktreePath: "/wt/fo_1/0-alpha",
    outputSchema: schema,
  });
  assert.match(text, /fanout worker/);
  assert.match(text, /the parent says hi/);
  assert.match(text, /create a\.txt containing A/);
  assert.match(text, /\/wt\/fo_1\/0-alpha/);
  assert.match(text, /"required"/);
  assert.match(text, /submit_result/);
  assert.match(text, /never run git commit or git push/);
});

test("composeWorkerPrompt has a no-schema fallback wording", () => {
  const text = composeWorkerPrompt({
    context: "",
    task: "do a thing",
    worktreePath: "/wt/x",
    outputSchema: null,
  });
  assert.match(text, /no schema was given/);
  assert.match(text, /do a thing/);
  assert.doesNotMatch(text, /Shared context/);
});

test("sanitizeTaskName is filesystem-safe and bounded", () => {
  assert.equal(sanitizeTaskName("Fix The Thing!!"), "fix-the-thing");
  assert.equal(sanitizeTaskName("  "), "task");
  assert.equal(sanitizeTaskName(""), "task");
  assert.equal(sanitizeTaskName(null), "task");
  assert.equal(sanitizeTaskName("a/b\\c:d"), "a-b-c-d");
  assert.ok(sanitizeTaskName("x".repeat(100)).length <= 40);
  assert.match(DEFAULT_WORKTREE_BASE, /\.cache[\\\/]opencode[\\\/]fusion-tools[\\\/]worktrees$/);
});

test("finalAssistantText extracts the last non-empty assistant text", () => {
  assert.equal(
    finalAssistantText([
      { type: "user", content: [{ type: "text", text: "hi" }] },
      { type: "assistant", content: [{ type: "text", text: "first" }] },
      { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "last" }] },
    ]),
    "last",
  );
  assert.equal(finalAssistantText([{ type: "assistant", content: [{ type: "reasoning", text: "hmm" }] }]), null);
  assert.equal(finalAssistantText([]), null);
  assert.equal(finalAssistantText(null), null);
  assert.equal(finalAssistantText([{ type: "assistant" }]), null);
});

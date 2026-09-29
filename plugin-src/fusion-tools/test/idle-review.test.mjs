// fusion-tools tests: idle-triggered final review (deferred-note flush gap).
//
// Drives the REAL plugin setup(ctx) against a mocked plugin context:
// (a) session.idle for a watched primary flushes notes deferred during the
//     busy phase (delivered via synthetic at the turn boundary), and the
//     subsequent empty-delta review does NOT prompt the advisor;
// (b) session.idle with an empty delta and no deferred notes is skipped
//     (log line "review skipped (no delta, no deferred)") without prompting;
// (c) session.idle for a session that was never watched does nothing.
//
// Run: node --test plugin-src/fusion-tools/test/

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

// Isolate the plugin log: test runs must never append to the live state
// file (~/.local/state/opencode/fusion-tools.log). The temp dir is removed
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

import plugin, { default as defaultPlugin } from "../index.js";
import { ACK_QUEUED, ACK_DELIVERED } from "../lib/routing.js";
import { logFile } from "../lib/log.js";

// The module's default export is the Plugin.define result itself.
assert.equal(plugin, defaultPlugin);

function makeCtx() {
  const hooks = { context: null };
  const tools = [];
  const commands = [];
  const calls = {
    advisorCreate: [], // {agent, metadata}
    prompts: [], // {sessionID, text}
    synthetics: [], // {sessionID, text}
    interrupts: [],
  };
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

  const ctx = {
    options: {
      advisor: {
        enabled: true,
        model: "opencode-go/deepseek-v4.1-flash",
        scope: ["build", "plan"],
        reviewTimeoutMs: 50, // keep the timeout race short in tests
        // These tests exercise the legacy mid-turn + every-idle behavior;
        // the idle-complex gating has its own suite (activation.test.mjs).
        activation: "always",
      },
    },
    // no storage domain: the adapter degrades to the in-memory mirror
    storage: undefined,
    event: { subscribe: () => stream },
    session: {
      hook: async (name, fn) => {
        hooks[name] = fn;
        return { dispose: async () => {} };
      },
      context: async () => null, // overridden per test via setMessages
      create: async (input) => {
        calls.advisorCreate.push(input);
        return { id: "advisor-ses-" + calls.advisorCreate.length };
      },
      prompt: async (input) => {
        calls.prompts.push({ sessionID: input.sessionID, text: input.text });
      },
      wait: async () => {},
      interrupt: async () => {},
      synthetic: async (input) => {
        calls.synthetics.push({ sessionID: input.sessionID, text: input.text });
      },
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
  return {
    ctx,
    hooks,
    tools,
    commands,
    calls,
    pushEvent: stream.push,
    setContextMessages(list) {
      ctx.session.context = async () => list;
    },
  };
}

function waitUntil(cond, ms = 2000) {
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

function advisorPrompts(calls) {
  return calls.prompts.filter((p) => String(p.sessionID).startsWith("advisor-ses-"));
}

test("idle-triggered review flushes deferred notes (no advisor prompt needed)", async () => {
  const h = makeCtx();
  h.setContextMessages([
    { id: "m1", type: "user", text: "step one content" },
    { id: "m2", type: "assistant", agent: "build", content: [{ type: "text", text: "step one reply" }] },
  ]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    assert.ok(h.hooks.context, "context hook registered");
    assert.equal(h.tools.length, 1, "advise tool registered");
    const advise = h.tools[0];

    // Mid-turn: context hook fires for the watched primary.
    h.hooks.context({ sessionID: "P-main", agent: "build" });
    await waitUntil(() => advisorPrompts(h.calls).length === 1);
    assert.equal(h.calls.advisorCreate.length, 1, "one advisor session");
    const advisorSessionID = "advisor-ses-1";

    // Advisor emits a concern while the primary is still busy -> deferred.
    const ack = await advise.execute(
      { note: "check the retry loop for a race condition", severity: "concern" },
      { sessionID: advisorSessionID },
    );
    assert.equal(ack.content, ACK_QUEUED);

    // Nothing delivered while busy; the note sits in the deferred queue.
    assert.equal(h.calls.synthetics.length, 0);

    // Terminal turn boundary: session.idle fires -> final review -> flush.
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-main" } });
    await waitUntil(() => h.calls.synthetics.length === 1);
    await settle();

    assert.equal(h.calls.synthetics.length, 1, "deferred concern delivered exactly once");
    assert.equal(h.calls.synthetics[0].sessionID, "P-main");
    assert.match(h.calls.synthetics[0].text, /check the retry loop for a race condition/);
    assert.match(h.calls.synthetics[0].text, /severity="concern"/);
    // The idle-triggered review found an empty delta (cursor already at the
    // end) and must NOT have re-prompted the advisor.
    assert.equal(advisorPrompts(h.calls).length, 1, "no advisor prompt for the empty-delta idle review");
    assert.equal(h.calls.advisorCreate.length, 1, "no second advisor session");
  } finally {
    await cleanup();
  }
  await settle();
});

test("idle-triggered review with empty delta and no deferred notes is skipped without prompting", async () => {
  const h = makeCtx();
  h.setContextMessages([{ id: "m1", type: "user", text: "the only turn" }]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    // First review (context hook) actually prompts the advisor.
    h.hooks.context({ sessionID: "P-skip", agent: "build" });
    await waitUntil(() => advisorPrompts(h.calls).length === 1);
    assert.equal(h.calls.advisorCreate.length, 1);
    assert.equal(h.calls.synthetics.length, 0);

    // Nothing new since the cursor: the idle-triggered review must skip.
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-skip" } });
    await settle();
    await settle();

    assert.equal(advisorPrompts(h.calls).length, 1, "no advisor prompt on the idle review");
    assert.equal(h.calls.advisorCreate.length, 1, "no advisor session churn on the idle review");
    assert.equal(h.calls.synthetics.length, 0, "no synthetic deliveries either");

    // The skip is observable in the plugin log.
    const logText = await readFile(logFile(), "utf8");
    assert.match(
      logText,
      /"msg":"review skipped \(no delta, no deferred\)","primarySessionID":"P-skip"/,
    );
  } finally {
    await cleanup();
  }
  await settle();
});

test("idle for a never-watched or out-of-scope session triggers nothing", async () => {
  const h = makeCtx();
  h.setContextMessages([]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    // No context hook ever fired for these sessions.
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-unknown" } });
    h.pushEvent({ type: "session.idle", data: { sessionID: "advisor-ses-1" } });
    await settle();
    await settle();

    assert.equal(h.calls.advisorCreate.length, 0, "no advisor session for unknown idle");
    assert.equal(advisorPrompts(h.calls).length, 0);
    assert.equal(h.calls.synthetics.length, 0);
  } finally {
    await cleanup();
  }
  await settle();
});

test("idle-triggered review coalesces into the in-flight review via the per-primary mutex", async () => {
  const h = makeCtx();
  // Slow advisor prompt: the first review stays in flight; the idle event
  // must coalesce (pending) instead of starting a second concurrent pass.
  const releaseAdvisorWait = { fn: null };
  h.ctx.session.wait = async () =>
    new Promise((resolve) => {
      releaseAdvisorWait.fn = resolve;
    });
  h.setContextMessages([{ id: "m1", type: "user", text: "turn content" }]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    // Park a deferred note BEFORE any review runs, by pre-filling the queue
    // through a busy-context hook + advise... simpler: rely on the mutex:
    // hook fires -> review 1 in flight (prompt admitted, wait pending).
    h.hooks.context({ sessionID: "P-mutex", agent: "build" });
    await waitUntil(() => advisorPrompts(h.calls).length === 1);

    // Idle arrives while review 1 still holds the mutex.
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-mutex" } });
    await settle();

    // Review 1 completes; the coalesced pending review then runs.
    releaseAdvisorWait.fn();
    await waitUntil(() => logTextHas(/"msg":"review coalesced \(mutex busy\)","primarySessionID":"P-mutex"/));
    await settle();
    // Only one advisor prompt happened (the coalesced pass saw an empty
    // delta and skipped, no second prompt).
    assert.equal(advisorPrompts(h.calls).length, 1);
  } finally {
    await cleanup();
  }
  await settle();
});

async function logTextHas(re) {
  const t = await readFile(logFile(), "utf8");
  return re.test(t);
}

test("idle-triggered review delivers a deferred blocker as a steer prompt", async () => {
  const h = makeCtx();
  h.setContextMessages([{ id: "m1", type: "user", text: "turn content" }]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    h.hooks.context({ sessionID: "P-blocker", agent: "plan" });
    await waitUntil(() => advisorPrompts(h.calls).length === 1);
    const ack = await h.tools[0].execute(
      { note: "the migration step runs before the backup completes", severity: "blocker" },
      { sessionID: "advisor-ses-1" },
    );
    assert.equal(ack.content, ACK_DELIVERED); // busy x blocker -> prompt steer
    assert.equal(h.calls.prompts.filter((p) => p.sessionID === "P-blocker").length, 1);

    // Now idle with an empty delta: the review skips the advisor prompt but
    // the already-delivered blocker must NOT be re-delivered.
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-blocker" } });
    await settle();
    await settle();
    assert.equal(
      h.calls.prompts.filter((p) => p.sessionID === "P-blocker").length,
      1,
      "blocker not re-steered after delivery",
    );
  } finally {
    await cleanup();
  }
  await settle();
});

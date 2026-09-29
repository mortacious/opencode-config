// fusion-tools tests: advisor activation gating (Part B).
//
// Drives the REAL plugin setup(ctx) against a mocked plugin context (same
// pattern as test/idle-review.test.mjs). Covered:
//   1. idle-complex skips mid-turn triggers
//   2. idle review fires above the steps threshold
//   3. idle review fires above the delta-chars threshold
//   4. idle review skipped below thresholds -> cursor advance + skip log
//   5. /advisor on forces reviews below threshold
//   6. /advisor off suppresses everything
//   7. activation "off" registers no triggers (advise tool + command only)
//   8. "always" keeps mid-turn reviews (legacy behavior)
//   9. circuit breaker trips after 3 failures, pauses, recovers after expiry
//  10. breaker counts reset on success
//  11. command handlers: on / off / status / unknown arg + persistence
//  12. overrides rehydrate from storage after reload
//
// Run: node --test plugin-src/fusion-tools/test/

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

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
import { logFile } from "../lib/log.js";

const CURSOR_PREFIX = "fusion-tools/advisor/cursor/";
const OVERRIDE_PREFIX = "fusion-tools/advisor/override/";

// ---------------------------------------------------------------- helpers

function makeCtx(overrides = {}) {
  const hooks = { context: null };
  const tools = [];
  const commands = [];
  const calls = {
    advisorCreate: [],
    prompts: [], // {sessionID, text}
    synthetics: [], // {sessionID, text}
    interrupts: [],
  };
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
        reviewTimeoutMs: 50,
        ...(overrides.advisor || {}),
      },
    },
    storage: fakeStorage,
    event: { subscribe: () => stream },
    session: {
      hook: async (name, fn) => {
        hooks[name] = fn;
        return { dispose: async () => {} };
      },
      context: async () => null, // overridden per test via setContextMessages
      create: async (input) => {
        calls.advisorCreate.push(input);
        return { id: "advisor-ses-" + calls.advisorCreate.length };
      },
      prompt: async (input) => {
        calls.prompts.push({ sessionID: input.sessionID, text: input.text });
      },
      wait: async () => {}, // overridden per test via setWait
      interrupt: async (input) => {
        calls.interrupts.push(input.sessionID);
      },
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
    storageMap,
    pushEvent: stream.push,
    setContextMessages(list) {
      ctx.session.context = async () => list;
    },
    setWait(fn) {
      ctx.session.wait = fn;
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

const settle = () => new Promise((r) => setTimeout(r, 30));

function advisorPrompts(calls) {
  return calls.prompts.filter((p) => String(p.sessionID).startsWith("advisor-ses-"));
}

async function readLog() {
  try {
    return await readFile(logFile(), "utf8");
  } catch {
    return "";
  }
}

function readLogSync() {
  try {
    return readFileSync(logFile(), "utf8");
  } catch {
    return "";
  }
}

function bigMessages(chars = 9000) {
  return [{ id: "m-big", type: "user", text: "x".repeat(chars) }];
}

// ------------------------------------------------------------------ tests

test("idle-complex skips mid-turn triggers (metrics recorded, no review)", async () => {
  const h = makeCtx();
  h.setContextMessages([{ id: "m1", type: "user", text: "turn content" }]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    h.hooks.context({ sessionID: "P-mid", agent: "build", messages: [{ role: "user" }] });
    await settle();
    await settle();

    assert.equal(advisorPrompts(h.calls).length, 0, "no mid-turn advisor prompt");
    assert.equal(h.calls.advisorCreate.length, 0, "no advisor session created mid-turn");

    // metrics were recorded by the hook (observable via the log line)
    const logText = await readLog();
    assert.match(
      logText,
      /"msg":"context hook \(primary turn\)","primarySessionID":"P-mid","agent":"build","turnSteps":1/,
    );
  } finally {
    await cleanup();
  }
  await settle();
});

test("idle-complex: idle review fires above the steps threshold", async () => {
  const h = makeCtx({ advisor: { activation: "idle-complex", minStepsTurn: 3 } });
  h.setContextMessages([{ id: "m1", type: "user", text: "real turn content" }]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    for (let i = 0; i < 3; i++) {
      h.hooks.context({ sessionID: "P-steps", agent: "build", messages: [] });
    }
    assert.equal(advisorPrompts(h.calls).length, 0, "still no mid-turn review");
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-steps" } });
    await waitUntil(() => advisorPrompts(h.calls).length === 1);
    assert.equal(h.calls.advisorCreate.length, 1);
  } finally {
    await cleanup();
  }
  await settle();
});

test("idle-complex: idle review fires above the delta-chars threshold", async () => {
  const h = makeCtx({ advisor: { activation: "idle-complex", minTurnDeltaChars: 1000 } });
  h.setContextMessages(bigMessages(2000));
  const cleanup = await plugin.setup(h.ctx);
  try {
    // a single step, but the outbound payload exceeds the chars threshold
    h.hooks.context({ sessionID: "P-chars", agent: "build", messages: bigMessages(2000) });
    assert.equal(advisorPrompts(h.calls).length, 0);
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-chars" } });
    await waitUntil(() => advisorPrompts(h.calls).length === 1);
  } finally {
    await cleanup();
  }
  await settle();
});

test("idle-complex: below thresholds -> cursor advance + skip log, no review", async () => {
  const h = makeCtx({ advisor: { activation: "idle-complex", minStepsTurn: 8, minTurnDeltaChars: 8000 } });
  h.setContextMessages([
    { id: "m1", type: "user", text: "small turn" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "reply" }] },
  ]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    h.hooks.context({ sessionID: "P-small", agent: "build", messages: [{ role: "user", content: "hi" }] });
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-small" } });
    await settle();
    await settle();

    assert.equal(advisorPrompts(h.calls).length, 0, "no advisor prompt below thresholds");
    assert.equal(h.calls.advisorCreate.length, 0, "no advisor session below thresholds");

    // cursor advanced to the newest message so the skipped turn is not re-read
    const cursor = h.storageMap.get(CURSOR_PREFIX + "P-small");
    assert.deepEqual(cursor, { lastMessageID: "m2" }, "cursor advanced to now");

    const logText = await readLog();
    assert.match(
      logText,
      /"msg":"idle review skipped \(below threshold\)","primarySessionID":"P-small","turnSteps":1,"turnDeltaChars":\d+,"minStepsTurn":8,"minTurnDeltaChars":8000/,
    );
  } finally {
    await cleanup();
  }
  await settle();
});

test("/advisor on forces reviews below threshold", async () => {
  const h = makeCtx({ advisor: { activation: "idle-complex", minStepsTurn: 8, minTurnDeltaChars: 8000 } });
  h.setContextMessages([{ id: "m1", type: "user", text: "small turn" }]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    const cmd = h.commands.find((c) => c.name === "advisor");
    assert.ok(cmd, "advisor command registered");
    await cmd.execute({ sessionID: "P-force", prompt: { text: "on" } });
    await settle();
    assert.match(h.calls.synthetics[0].text, /forced ON/);
    assert.deepEqual(h.storageMap.get(OVERRIDE_PREFIX + "P-force"), { override: "on" });

    h.hooks.context({ sessionID: "P-force", agent: "build", messages: [{ role: "user" }] });
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-force" } });
    await waitUntil(() => advisorPrompts(h.calls).length === 1, "forced-on reviews despite sub-threshold turn");
  } finally {
    await cleanup();
  }
  await settle();
});

test("/advisor off suppresses everything for that session", async () => {
  const h = makeCtx({ advisor: { activation: "always" } });
  h.setContextMessages(bigMessages(9000));
  const cleanup = await plugin.setup(h.ctx);
  try {
    const cmd = h.commands.find((c) => c.name === "advisor");
    await cmd.execute({ sessionID: "P-quiet", prompt: { text: "off" } });
    await settle();

    // mid-turn: suppressed even in "always" mode
    h.hooks.context({ sessionID: "P-quiet", agent: "build", messages: bigMessages(9000) });
    await settle();
    assert.equal(advisorPrompts(h.calls).length, 0);

    // idle: suppressed too
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-quiet" } });
    await settle();
    await settle();
    assert.equal(advisorPrompts(h.calls).length, 0, "no reviews at all");
    assert.equal(h.calls.advisorCreate.length, 0);

    const logText = await readLog();
    assert.match(logText, /"msg":"idle review suppressed \(session override off\)","primarySessionID":"P-quiet"/);
  } finally {
    await cleanup();
  }
  await settle();
});

test("activation off registers the advise tool + command but no triggers", async () => {
  const h = makeCtx({ advisor: { activation: "off" } });
  h.setContextMessages(bigMessages(9000));
  const cleanup = await plugin.setup(h.ctx);
  try {
    assert.ok(h.tools.find((t) => t.name === "advise"), "advise tool still registered");
    assert.ok(h.commands.find((c) => c.name === "advisor"), "advisor command still registered");

    h.hooks.context({ sessionID: "P-off", agent: "build", messages: bigMessages(9000) });
    await settle();
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-off" } });
    await settle();
    await settle();

    assert.equal(advisorPrompts(h.calls).length, 0, "no reviews in off mode");
    assert.equal(h.calls.advisorCreate.length, 0, "no advisor sessions in off mode");
    // even a forced-on session gets no reviews while activation is off
    const cmd = h.commands.find((c) => c.name === "advisor");
    await cmd.execute({ sessionID: "P-off-on", prompt: { text: "on" } });
    h.hooks.context({ sessionID: "P-off-on", agent: "build", messages: bigMessages(9000) });
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-off-on" } });
    await settle();
    await settle();
    assert.equal(advisorPrompts(h.calls).length, 0, "override cannot override a global off");
  } finally {
    await cleanup();
  }
  await settle();
});

test("activation always keeps mid-turn reviews (legacy behavior)", async () => {
  const h = makeCtx({ advisor: { activation: "always" } });
  h.setContextMessages([{ id: "m1", type: "user", text: "turn content" }]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    h.hooks.context({ sessionID: "P-always", agent: "build", messages: [] });
    await waitUntil(() => advisorPrompts(h.calls).length === 1);
    assert.equal(h.calls.advisorCreate.length, 1);
  } finally {
    await cleanup();
  }
  await settle();
});

test("circuit breaker: trips after 3 consecutive failures, pauses, recovers", async () => {
  const h = makeCtx({
    advisor: { activation: "always", failurePauseMs: 60 },
  });
  h.setContextMessages([{ id: "m1", type: "user", text: "turn content" }]);
  let waitBehavior = "reject";
  h.setWait(async () => {
    if (waitBehavior === "reject") throw new Error("Upstream request failed: Insufficient account funds");
    return undefined;
  });
  const cleanup = await plugin.setup(h.ctx);
  let waitErrors = 0;
  h.setWait(async () => {
    if (waitBehavior === "reject") {
      waitErrors += 1;
      throw new Error("Upstream request failed: Insufficient account funds");
    }
    return undefined;
  });
  try {
    // three consecutive failing reviews. Each turn adds a fresh transcript
    // message so the review sees a non-empty delta, prompts the advisor,
    // and the wait rejection is recorded as a failure.
    for (let i = 0; i < 3; i++) {
      h.setContextMessages([{ id: "m" + i, type: "user", text: "turn " + i + " content" }]);
      h.hooks.context({ sessionID: "P-breaker", agent: "build", messages: [] });
      await waitUntil(() => waitErrors >= i + 1);
      await settle();
    }
    let logText = await readLog();
    assert.match(logText, /"msg":"advisor breaker tripped \(reviews paused\)"/);

    // while paused: hooks skip with one log line, no new reviews
    h.hooks.context({ sessionID: "P-breaker", agent: "build", messages: [] });
    await settle();
    logText = await readLog();
    assert.match(logText, /"msg":"advisor reviews paused \(breaker\); review skipped","primarySessionID":"P-breaker"/);
    const promptsWhilePaused = advisorPrompts(h.calls).length;

    // after the pause expires the breaker re-arms; a successful review recovers
    await new Promise((r) => setTimeout(r, 80));
    waitBehavior = "resolve";
    h.setContextMessages([{ id: "rec", type: "user", text: "recovery turn content" }]);
    h.hooks.context({ sessionID: "P-breaker", agent: "build", messages: [] });
    await waitUntil(() => advisorPrompts(h.calls).length > promptsWhilePaused);
    // recovery is observable: the pause expired (re-armed) and the review finished
    const afterPauseLog = await readLog();
    assert.match(afterPauseLog, /"msg":"advisor breaker pause expired \(re-armed\)"/);
    const finishedAfterPause = afterPauseLog.slice(afterPauseLog.lastIndexOf("advisor breaker pause expired"));
    assert.match(finishedAfterPause, /"msg":"advisor review finished"/);
  } finally {
    await cleanup();
  }
  await settle();
});

test("circuit breaker: a success resets the failure count", async () => {
  const h = makeCtx({ advisor: { activation: "always" } });
  h.setContextMessages([{ id: "m1", type: "user", text: "turn content" }]);
  let waitBehavior = "reject";
  h.setWait(async () => {
    if (waitBehavior === "reject") throw new Error("quota");
    return undefined;
  });
  const cleanup = await plugin.setup(h.ctx);
  let waitErrors = 0;
  h.setWait(async () => {
    if (waitBehavior === "reject") {
      waitErrors += 1;
      throw new Error("quota");
    }
    return undefined;
  });
  try {
    const cmd = h.commands.find((c) => c.name === "advisor");
    // 2 failures (fresh content per turn so each review actually prompts)
    for (let i = 0; i < 2; i++) {
      h.setContextMessages([{ id: "m" + i, type: "user", text: "turn " + i + " content" }]);
      h.hooks.context({ sessionID: "P-reset", agent: "build", messages: [] });
      await waitUntil(() => waitErrors >= i + 1);
      await settle();
    }
    // ...then a success (fresh content so the review has a delta)
    waitBehavior = "resolve";
    h.setContextMessages([{ id: "ok", type: "user", text: "recovery turn content" }]);
    h.hooks.context({ sessionID: "P-reset", agent: "build", messages: [] });
    await waitUntil(() => readLogSync().includes('"msg":"advisor breaker reset (review succeeded)"'));
    await settle();

    // status reports an armed breaker at 0/3
    await cmd.execute({ sessionID: "P-reset", prompt: { text: "status" } });
    await settle();
    const status = h.calls.synthetics.find((s) => s.text.includes("advisor status:"));
    assert.ok(status, "status feedback delivered");
    assert.match(status.text, /consecutive failures 0\/3/);
    assert.match(status.text, /armed/);

    // two more failures do NOT trip the breaker (the count restarted)
    waitBehavior = "reject";
    const tripMarker = () => {
      const t = readLogSync();
      const resetIdx = t.lastIndexOf("advisor breaker reset");
      return t.slice(resetIdx).includes("advisor breaker tripped");
    };
    for (let i = 0; i < 2; i++) {
      h.setContextMessages([{ id: "n" + i, type: "user", text: "post-reset turn " + i }]);
      h.hooks.context({ sessionID: "P-reset", agent: "build", messages: [] });
      await waitUntil(() => waitErrors >= 3 + i);
      await settle();
    }
    assert.equal(tripMarker(), false, "2 failures after a reset do not trip the breaker");
  } finally {
    await cleanup();
  }
  await settle();
});

test("/advisor command: on, off, status, and unknown argument", async () => {
  const h = makeCtx({ advisor: { activation: "idle-complex" } });
  h.setContextMessages([{ id: "m1", type: "user", text: "turn content" }]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    const cmd = h.commands.find((c) => c.name === "advisor");

    // status before any override/review
    await cmd.execute({ sessionID: "P-cmd", prompt: { text: "status" } });
    await settle();
    let feedback = h.calls.synthetics[h.calls.synthetics.length - 1];
    assert.match(feedback.text, /advisor status:/);
    assert.match(feedback.text, /activation: idle-complex \(no session override\)/);
    assert.match(feedback.text, /this session: 0 completed review/);
    assert.match(feedback.text, /total completed reviews: 0/);
    assert.match(feedback.text, /breaker: armed \(consecutive failures 0\/3\)/);

    // full-line form also parses ("/advisor on")
    await cmd.execute({ sessionID: "P-cmd", prompt: { text: "/advisor on" } });
    await settle();
    assert.deepEqual(h.storageMap.get(OVERRIDE_PREFIX + "P-cmd"), { override: "on" });
    feedback = h.calls.synthetics[h.calls.synthetics.length - 1];
    assert.match(feedback.text, /forced ON/);

    // a review runs (forced-on), then status reflects the count
    h.hooks.context({ sessionID: "P-cmd", agent: "build", messages: [] });
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-cmd" } });
    await waitUntil(() => advisorPrompts(h.calls).length === 1);
    await settle();
    await cmd.execute({ sessionID: "P-cmd", prompt: { text: "status" } });
    await settle();
    feedback = h.calls.synthetics[h.calls.synthetics.length - 1];
    assert.match(feedback.text, /session override: on/);
    assert.match(feedback.text, /this session: 1 completed review/);
    assert.match(feedback.text, /total completed reviews: 1/);

    // off clears the forced state
    await cmd.execute({ sessionID: "P-cmd", prompt: { text: "off" } });
    await settle();
    assert.deepEqual(h.storageMap.get(OVERRIDE_PREFIX + "P-cmd"), { override: "off" });
    feedback = h.calls.synthetics[h.calls.synthetics.length - 1];
    assert.match(feedback.text, /suppressed/);

    // unknown argument -> usage hint
    await cmd.execute({ sessionID: "P-cmd", prompt: { text: "banana" } });
    await settle();
    feedback = h.calls.synthetics[h.calls.synthetics.length - 1];
    assert.match(feedback.text, /unknown argument "banana"/);
    assert.match(feedback.text, /Usage: \/advisor on \| off \| status/);

    // command feedback is marked as self so renders/reviews drop it
    h.setContextMessages([
      { id: "m1", type: "user", text: "turn content" },
      { id: "m2", type: "synthetic", text: "advisor: reviews suppressed for this session.", metadata: { fusionTools: "advisor-note" } },
    ]);
    h.hooks.context({ sessionID: "P-cmd", agent: "build", messages: [] });
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-cmd" } });
    await settle();
    await settle();
    // the synthetic aside never reached the advisor (self-filtered from the delta)
    assert.equal(advisorPrompts(h.calls).length, 1, "no review for an override-off session");
  } finally {
    await cleanup();
  }
  await settle();
});

test("overrides rehydrate from storage after a plugin reload", async () => {
  const storageMap = new Map();
  storageMap.set(OVERRIDE_PREFIX + "P-keep", { override: "on" });
  const h = makeCtx({ advisor: { activation: "idle-complex", minStepsTurn: 8 } });
  h.storageMap = storageMap;
  // point the fake storage at the pre-seeded map
  h.ctx.storage.get = async (key) => (storageMap.has(key) ? storageMap.get(key) : undefined);
  h.ctx.storage.scan = async ({ prefix, after }) => {
    const entries = [...storageMap.entries()]
      .filter(([k]) => k.startsWith(prefix) && (!after || k > after))
      .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
      .map(([key, value]) => ({ key, value }));
    return { entries, next: null };
  };
  h.setContextMessages([{ id: "m1", type: "user", text: "small turn" }]);
  const cleanup = await plugin.setup(h.ctx);
  try {
    await settle();
    const logText = await readLog();
    assert.match(logText, /"msg":"rehydrated advisor mappings from storage"[^]*?"overrides":1/);

    // the rehydrated "on" override bypasses the threshold at idle
    h.hooks.context({ sessionID: "P-keep", agent: "build", messages: [{ role: "user" }] });
    h.pushEvent({ type: "session.idle", data: { sessionID: "P-keep" } });
    await waitUntil(() => advisorPrompts(h.calls).length === 1);
  } finally {
    await cleanup();
  }
  await settle();
});

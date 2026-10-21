// subagent-cap tests: cap enforcement, blocking, reconcile-release, unlimited,
// child-session extraction, and the fail-open option warnings.
//
// Drives the real wrapper (lib/transform.js installCap) against a fake
// ToolEditor and the real accounting core (lib/cap.js createCapState). The
// counter is instrumented through state.count() / state.trackedIDs().

import { test } from "node:test";
import assert from "node:assert/strict";

import { Error as ToolError } from "@opencode/plugin/promise/tool";

import {
  createCapState,
  extractSessionID,
  normalizeOptions,
  resolveEffectiveCap,
} from "../lib/cap.js";
import { installCap } from "../lib/transform.js";
import plugin from "../index.js";

const QUIET = { log: () => {}, warn: () => {} };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Minimal ToolEditor: list/get/update over a Map of live tool objects, with
// update on a missing id being a no-op (same silent behavior as the real one).
function makeEditor(tools) {
  const map = new Map(tools.map((tool) => [tool.id, tool]));
  const editor = {
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    update: (id, update) => {
      const tool = map.get(id);
      if (!tool) return;
      update(tool);
    },
    add: () => {},
    remove: (id) => {
      map.delete(id);
    },
    namespace: () => {},
  };
  return { editor, map };
}

function cappedTask(execute, id = "task") {
  return { id, name: id, input: {}, description: "fake spawn tool", execute };
}

test("cap enforcement: 3 concurrent calls pass and the counter reaches 3", async () => {
  const state = createCapState({ cap: 3, profile: "cheap-local", getSession: async () => undefined });
  const gate = deferred();
  let originals = 0;
  const tool = cappedTask(async () => {
    originals += 1;
    await gate.promise;
    return { content: "done" };
  });
  const { editor, map } = makeEditor([tool]);
  const outcome = installCap({ editor, toolIds: ["subagent", "task"], state, logger: QUIET });
  assert.deepEqual(outcome.wrapped, ["task"], "existing id is wrapped");

  const calls = [1, 2, 3].map(() => map.get("task").execute({ prompt: "x" }, {}));
  assert.equal(state.count(), 3, "counter increments synchronously at wrap entry");
  gate.resolve();
  const results = await Promise.all(calls);
  assert.equal(results.length, 3);
  assert.equal(originals, 3, "each call reached the original execute exactly once");
  assert.equal(state.count(), 0, "foreground settlement releases every slot");
});

test("blocking: a 4th call is rejected with Tool.Error and no phantom count", async () => {
  const state = createCapState({ cap: 3, profile: "cheap-local", getSession: async () => undefined });
  const gate = deferred();
  const tool = cappedTask(async () => {
    await gate.promise;
    return { content: "done" };
  });
  const { editor, map } = makeEditor([tool]);
  installCap({ editor, toolIds: ["subagent", "task"], state, logger: QUIET });

  const running = [1, 2, 3].map(() => map.get("task").execute({}, {}));
  assert.equal(state.count(), 3);

  const expected =
    'subagent cap reached: 3/3 running under profile "cheap-local" - this delegation was blocked. ' +
    "Wait for running subagents to finish, then retry (completed subagents free capacity automatically).";

  await assert.rejects(map.get("task").execute({ prompt: "4th" }, {}), (err) => {
    assert.ok(err instanceof ToolError, "block error is Tool.Error, not a bare Error");
    assert.equal(err._tag, "Tool.Error");
    assert.equal(err.message, expected);
    return true;
  });
  assert.equal(state.count(), 3, "a blocked attempt must not increment the counter");

  gate.resolve();
  await Promise.all(running);
  assert.equal(state.count(), 0);
});

test("reconcile-release: an idle tracked child frees capacity on the next blocked attempt", async () => {
  let childIdle = false;
  const seen = [];
  const getSession = async (sessionID) => {
    seen.push(sessionID);
    return { id: sessionID, time: childIdle ? { idle: 1730000000000 } : {} };
  };
  const state = createCapState({ cap: 3, profile: "cheap-local", getSession });
  const hang = deferred();
  const fourth = deferred();
  const fourthEntered = deferred();
  let call = 0;
  const tool = cappedTask(async () => {
    call += 1;
    if (call <= 2) {
      await hang.promise;
      return { content: "foreground done" };
    }
    if (call === 3) {
      // Background-style spawn: resolves with the child session id while the
      // child is still running, so the slot stays tracked.
      return { output: { sessionID: "ses_child_1" } };
    }
    fourthEntered.resolve();
    await fourth.promise;
    return { content: "fourth done" };
  });
  const { editor, map } = makeEditor([tool]);
  installCap({ editor, toolIds: ["subagent", "task"], state, logger: QUIET });

  const first = map.get("task").execute({}, {});
  const second = map.get("task").execute({}, {});
  const third = await map.get("task").execute({}, {});
  assert.equal(third.output.sessionID, "ses_child_1");
  assert.equal(state.count(), 3, "running child is still tracked after its spawn returned");
  assert.deepEqual(state.trackedIDs(), ["ses_child_1"]);

  childIdle = true;
  const fourthCall = map.get("task").execute({}, {});
  await fourthEntered.promise;
  assert.ok(seen.includes("ses_child_1"), "blocked attempt reconciled the tracked child via session.get");
  assert.equal(state.count(), 3, "2 foreground + the 4th call (idle child released)");
  assert.deepEqual(state.trackedIDs(), [], "idle child is no longer tracked");

  hang.resolve();
  fourth.resolve();
  await Promise.all([first, second, fourthCall]);
  assert.equal(state.count(), 0);
});

test("unlimited: max 0 leaves the tool unwrapped and never rejects", async () => {
  const opts = normalizeOptions({ max: 0, profiles: { "cheap-local": 3 } });
  assert.equal(opts.max, 0);
  assert.equal(resolveEffectiveCap(opts, "secure"), 0, "profile absent from the map -> max");

  // index.js setup gate: no transform registration for an effective cap of 0.
  // Force the base (no profile) launch so a parent OPENCODE_CONFIG cannot
  // turn this into a capped profile.
  const savedConfig = process.env.OPENCODE_CONFIG;
  delete process.env.OPENCODE_CONFIG;
  let transforms = 0;
  const ctx = {
    options: { max: 0, profiles: { "cheap-local": 3 } },
    tool: {
      transform: async () => {
        transforms += 1;
        return { dispose: async () => {} };
      },
    },
    session: { get: async () => undefined },
  };
  try {
    const cleanup = await plugin.setup(ctx);
    assert.equal(transforms, 0, "no transform is registered when unlimited");
    assert.equal(cleanup, undefined);
  } finally {
    if (savedConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = savedConfig;
  }

  // Direct core check: no acquisition is possible under a zero cap.
  const state = createCapState({ cap: 0, profile: "base", getSession: async () => undefined });
  assert.equal(state.tryAcquire(), null);
  assert.equal(state.count(), 0);
});

test("extractSessionID: metadata key, output key, content text, and nothing", () => {
  // The spawn result shape is unverified on this build, so all known carriers
  // are probed: output/metadata fields first, then the session-id text.
  assert.equal(extractSessionID({ metadata: { sessionID: "ses_meta123" } }), "ses_meta123");
  assert.equal(extractSessionID({ output: { sessionID: "ses_out123" } }), "ses_out123");
  assert.equal(
    extractSessionID({ content: "spawned ses_text12345 for you" }),
    "ses_text12345"
  );
  assert.equal(
    extractSessionID({ content: [{ type: "text", text: "child ses_part123 ok" }] }),
    "ses_part123"
  );

  // Nothing session-shaped present -> undefined (callers free the slot).
  assert.equal(extractSessionID({ content: "ok" }), undefined);
  assert.equal(extractSessionID({ output: { note: "nothing" }, metadata: {} }), undefined);
  assert.equal(extractSessionID(null), undefined);
  assert.equal(extractSessionID("ses_abc123"), undefined);
});

test("fail-open warning: a degenerate profiles entry warns once and stays uncapped", () => {
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(msg) };

  const opts = normalizeOptions({ max: 0, profiles: { "cheap-local": "3" } }, logger);
  assert.equal(opts.profiles["cheap-local"], undefined, "string cap degrades to absent");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /option profiles\["cheap-local"\]="3" normalizes to unlimited/);

  // Same degenerate value again (a plugin reload): already surfaced, silent.
  normalizeOptions({ max: 0, profiles: { "cheap-local": "3" } }, logger);
  assert.equal(warnings.length, 1, "warned once per degenerate value");

  // An explicit profiled 0 is also a silent-unlimited trap, so it warns too.
  normalizeOptions({ max: 0, profiles: { "cheap-local": 0 } }, logger);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /profiles\["cheap-local"\]=0/);
});

test("fail-open warning: explicit max 0 is intentional and silent", () => {
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(msg) };

  const zero = normalizeOptions({ max: 0, profiles: { "cheap-local": 3 } }, logger);
  assert.equal(zero.max, 0);
  assert.equal(warnings.length, 0, "explicit numeric max 0 must not warn");

  const bad = normalizeOptions({ max: "3" }, logger);
  assert.equal(bad.max, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /option max="3" is not a positive number/);
});

// fusion-tools tests: steer module (child tracking + /steer command).
//
// Unit tests with a mocked ctx: drives createSteerModule directly and
// feeds session.created / session.idle events in both observed shapes
// (properties.info for created - proven by the fusion-audit plugin -
// and flat sessionID for idle, as read by the advisor code).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

import { createSteerModule } from "../lib/steer.js";

function makeCtx() {
  const calls = { prompts: [], synthetics: [] };
  const ctx = {
    session: {
      prompt: async (input) => {
        calls.prompts.push(input);
      },
      synthetic: async (input) => {
        calls.synthetics.push(input);
      },
    },
  };
  return { ctx, calls };
}

// Three observed session.created shapes: properties.info with {id,
// parentID}, flat data with {id, parentID} (legacy fallback), and flat v2
// data with {sessionID, parentID} (hedged like fusion-audit).
function createdProps(id, parentID) {
  return { type: "session.created", properties: { info: { id, parentID } } };
}
function createdData(id, parentID) {
  return { type: "session.created", data: { id, parentID } };
}
function createdV2(sessionID, parentID) {
  return { type: "session.created", data: { sessionID, parentID } };
}
function idleProps(sessionID) {
  return { type: "session.idle", properties: { sessionID } };
}
function idleData(sessionID) {
  return { type: "session.idle", data: { sessionID } };
}

function lastSynthetic(calls) {
  return calls.synthetics[calls.synthetics.length - 1];
}

test("child tracking: created events record parent->children in order, idle marks done", () => {
  const { ctx } = makeCtx();
  const steer = createSteerModule({ ctx });
  steer.handleEvent(createdProps("c1", "P"));
  steer.handleEvent(createdData("c2", "P"));
  steer.handleEvent(createdProps("c3", "Q"));
  assert.deepEqual(steer.runningChildren("P"), ["c1", "c2"]);
  assert.deepEqual(steer.runningChildren("Q"), ["c3"]);
  assert.deepEqual(steer.runningChildren("unknown"), []);
  // idle in both shapes marks the child not running
  steer.handleEvent(idleProps("c1"));
  assert.deepEqual(steer.runningChildren("P"), ["c2"]);
  steer.handleEvent(idleData("c2"));
  assert.deepEqual(steer.runningChildren("P"), []);
  // malformed events never throw
  steer.handleEvent(null);
  steer.handleEvent({});
  steer.handleEvent({ type: "other" });
  steer.handleEvent({ type: "session.created" });
  steer.handleEvent({ type: "session.created", properties: { info: { id: "orphan" } } });
  steer.handleEvent({ type: "session.idle" });
  assert.deepEqual(steer.runningChildren("P"), []);
});

test("flat v2 shape (data.sessionID/data.parentID) is tracked and steerable", async () => {
  const { ctx, calls } = makeCtx();
  const steer = createSteerModule({ ctx });
  // v2 production shape: the ids sit flat on event.data under
  // sessionID/parentID (no nested info object, no id key). Regression test
  // for the info.id-only read that never recorded children in v2.
  steer.handleEvent({ type: "session.created", data: { sessionID: "ses_x", parentID: "ses_p" } });
  assert.deepEqual(steer.runningChildren("ses_p"), ["ses_x"], "child tracked from the v2 shape");
  await steer.command.execute({ sessionID: "ses_p", prompt: { text: "hedge check" } });
  assert.equal(calls.prompts.length, 1, "v2 child is steerable");
  assert.equal(calls.prompts[0].sessionID, "ses_x");
  assert.equal(calls.prompts[0].delivery, "steer");
  // idle marks it done
  steer.handleEvent({ type: "session.idle", data: { sessionID: "ses_x" } });
  assert.deepEqual(steer.runningChildren("ses_p"), []);
});

test("steer goes to the latest running child via prompt delivery steer", async () => {
  const { ctx, calls } = makeCtx();
  const steer = createSteerModule({ ctx });
  steer.handleEvent(createdProps("c1", "P"));
  steer.handleEvent(createdProps("c2", "P"));
  await steer.command.execute({ sessionID: "P", prompt: { text: "focus on the parser" } });
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].sessionID, "c2", "latest running child wins");
  assert.equal(calls.prompts[0].text, "focus on the parser");
  assert.equal(calls.prompts[0].delivery, "steer");
  // confirmation aside carries the fusionTools self-filter metadata
  assert.equal(calls.synthetics.length, 1);
  assert.equal(lastSynthetic(calls).sessionID, "P");
  assert.equal(lastSynthetic(calls).metadata.fusionTools, "steer");
  assert.equal(lastSynthetic(calls).resume, false);
  assert.match(lastSynthetic(calls).text, /steer delivered to the most recent of 2 running subagents/);
  assert.match(lastSynthetic(calls).text, /c2/);
});

test("steer accepts the full /steer command line and ignores an empty message", async () => {
  const { ctx, calls } = makeCtx();
  const steer = createSteerModule({ ctx });
  steer.handleEvent(createdProps("c1", "P"));
  await steer.command.execute({ sessionID: "P", prompt: { text: "/steer check the logs" } });
  assert.equal(calls.prompts[0].sessionID, "c1");
  assert.equal(calls.prompts[0].text, "check the logs");
  // empty message -> usage hint, no prompt
  await steer.command.execute({ sessionID: "P", prompt: { text: "  " } });
  assert.equal(calls.prompts.length, 1, "no extra prompt");
  assert.match(lastSynthetic(calls).text, /usage/i);
  // no sessionID -> nothing happens at all
  await steer.command.execute({ prompt: { text: "hi" } });
  assert.equal(calls.synthetics.length, 2, "no feedback without a parent session");
});

test("no running child: refusal aside, no prompt", async () => {
  const { ctx, calls } = makeCtx();
  const steer = createSteerModule({ ctx });
  // no children tracked at all
  await steer.command.execute({ sessionID: "P", prompt: { text: "hello" } });
  assert.equal(calls.prompts.length, 0);
  assert.match(lastSynthetic(calls).text, /no running subagent/);
  // tracked child already idle
  steer.handleEvent(createdProps("c1", "P2"));
  steer.handleEvent(idleProps("c1"));
  await steer.command.execute({ sessionID: "P2", prompt: { text: "hello" } });
  assert.equal(calls.prompts.length, 0);
  assert.match(lastSynthetic(calls).text, /no running subagent/);
});

test("multiple running children: the latest is steered and the confirmation says so", async () => {
  const { ctx, calls } = makeCtx();
  const steer = createSteerModule({ ctx });
  steer.handleEvent(createdProps("c1", "P"));
  steer.handleEvent(createdProps("c2", "P"));
  steer.handleEvent(createdProps("c3", "P"));
  steer.handleEvent(idleProps("c2")); // c2 finished; c1 and c3 still running
  await steer.command.execute({ sessionID: "P", prompt: { text: "wrap up" } });
  assert.equal(calls.prompts[0].sessionID, "c3");
  assert.match(lastSynthetic(calls).text, /most recent of 2 running subagents/);
  assert.match(lastSynthetic(calls).text, /c3/);
});

test("prompt failure is reported back as a failed-steer aside", async () => {
  const ctx = {
    session: {
      prompt: async () => {
        throw new Error("session not found");
      },
      synthetic: async (input) => {
        calls.synthetics.push(input);
      },
    },
  };
  const calls = { synthetics: [] };
  const steer = createSteerModule({ ctx });
  steer.handleEvent(createdProps("c1", "P"));
  await steer.command.execute({ sessionID: "P", prompt: { text: "hello" } });
  assert.equal(calls.synthetics.length, 1);
  assert.match(lastSynthetic(calls).text, /steer failed/);
  assert.match(lastSynthetic(calls).text, /session not found/);
});

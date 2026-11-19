// fusion-tools tests: steer module (child tracking + /steer command).
//
// Unit tests with a mocked ctx: drives createSteerModule directly and
// feeds session.created / session.idle events in both observed shapes
// (properties.info for created - proven by the fusion-audit plugin -
// and flat sessionID for idle, as read by the advisor code).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the plugin log: test runs must never append to the live state
// file (~/.local/state/opencode/fusion-tools.log). lib/log.js reads this
// env var lazily on every log()/logFile() call. The temp dir is removed
// after the suite finishes (top-level after hook).
const TEST_LOG_DIR = mkdtempSync(path.join(os.tmpdir(), "fusion-tools-test-log-"));
process.env.FUSION_TOOLS_LOG_FILE = path.join(TEST_LOG_DIR, "test.log");
// Steer notifications append to the durable channel log; keep every suite on
// a temp file so tests never touch the live fusion-inbox.jsonl.
process.env.FUSION_TOOLS_INBOX_FILE = path.join(TEST_LOG_DIR, "test-inbox.jsonl");
after(() => {
  try {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

import { createSteerModule } from "../lib/steer.js";

function makeCtx(options = {}) {
  const calls = { prompts: [], synthetics: [], lists: [], gets: [] };
  const sessions = options.sessions || new Map();
  const ctx = {
    session: {
      prompt: async (input) => {
        if (options.failPrompt) throw new Error(options.failPrompt);
        calls.prompts.push(input);
      },
      synthetic: async (input) => {
        if (options.failSynthetic) throw new Error(options.failSynthetic);
        calls.synthetics.push(input);
      },
      get: async ({ sessionID }) => {
        calls.gets.push(sessionID);
        const info = sessions.get(sessionID);
        if (!info) throw new Error("session not found: " + sessionID);
        return info;
      },
    },
  };
  if (options.list) {
    ctx.session.list = async (input) => {
      calls.lists.push(input);
      return options.list(input);
    };
  }
  return { ctx, calls, sessions };
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
  await steer.commandText("ses_p", "hedge check");
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
  await steer.commandText("P", "focus on the parser");
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].sessionID, "c2", "latest running child wins");
  assert.equal(calls.prompts[0].text, "focus on the parser");
  assert.equal(calls.prompts[0].delivery, "steer");
  // confirmation aside carries the fusionTools self-filter metadata
  assert.equal(calls.synthetics.length, 1);
  assert.equal(lastSynthetic(calls).sessionID, "P");
  assert.equal(lastSynthetic(calls).metadata.fusionTools, "steer");
  assert.equal(lastSynthetic(calls).resume, false);
  assert.match(lastSynthetic(calls).text, /steer delivered to child \(c2\) via command: focus on the parser/);
});

test("steer accepts the full /steer command line and ignores an empty message", async () => {
  const { ctx, calls } = makeCtx();
  const steer = createSteerModule({ ctx });
  steer.handleEvent(createdProps("c1", "P"));
  await steer.commandText("P", "/steer check the logs");
  assert.equal(calls.prompts[0].sessionID, "c1");
  assert.equal(calls.prompts[0].text, "check the logs");
  // empty message -> usage hint, no prompt
  await steer.commandText("P", "  ");
  assert.equal(calls.prompts.length, 1, "no extra prompt");
  assert.match(lastSynthetic(calls).text, /usage/i);
  // no sessionID -> nothing happens at all
  await steer.commandText(undefined, "hi");
  assert.equal(calls.synthetics.length, 2, "no feedback without a parent session");
});

test("no running child: refusal aside, no prompt", async () => {
  const { ctx, calls } = makeCtx();
  const steer = createSteerModule({ ctx });
  // no children tracked at all
  await steer.commandText("P", "hello");
  assert.equal(calls.prompts.length, 0);
  assert.match(lastSynthetic(calls).text, /no running subagent/);
  // tracked child already idle
  steer.handleEvent(createdProps("c1", "P2"));
  steer.handleEvent(idleProps("c1"));
  await steer.commandText("P2", "hello");
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
  await steer.commandText("P", "wrap up");
  assert.equal(calls.prompts[0].sessionID, "c3");
  assert.match(lastSynthetic(calls).text, /steer delivered to child \(c3\) via command: wrap up/);
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
  await steer.commandText("P", "hello");
  assert.equal(calls.synthetics.length, 1);
  assert.match(lastSynthetic(calls).text, /steer: delivery to c1 failed/);
  assert.match(lastSynthetic(calls).text, /session not found/);
});

// ------------------------------------------- steer / report model tools

function childInfo(id, parentID, agent, time) {
  const info = { id, parentID, agent };
  if (time) info.time = time;
  return info;
}

function inboxDir() {
  return mkdtempSync(path.join(os.tmpdir(), "fusion-inbox-test-"));
}

function inboxLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

test("steer tool: session id target delivers to that child and passes delivery through", async () => {
  const { ctx, calls, sessions } = makeCtx();
  sessions.set("ses_child", childInfo("ses_child", "ses_parent", "sidekick"));
  const steer = createSteerModule({ ctx });
  const res = await steer.tools.steer.execute(
    { target: "ses_child", message: "focus on the parser" },
    { sessionID: "ses_parent" },
  );
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].sessionID, "ses_child");
  assert.equal(calls.prompts[0].text, "focus on the parser");
  assert.equal(calls.prompts[0].delivery, "steer", "default delivery is steer");
  assert.deepEqual(res.metadata, {
    targetSessionID: "ses_child",
    agent: "sidekick",
    delivery: "steer",
  });
  assert.match(res.content, /steer delivered to sidekick \(ses_child\) via steer/);
  // explicit queue delivery
  await steer.tools.steer.execute(
    { target: "ses_child", message: "then run the tests", delivery: "queue" },
    { sessionID: "ses_parent" },
  );
  assert.equal(calls.prompts[1].delivery, "queue");
  assert.equal(calls.prompts[1].sessionID, "ses_child");
});

test("steer tool: a session id that is not a direct child is rejected", async () => {
  const { ctx, calls, sessions } = makeCtx();
  sessions.set("ses_other", childInfo("ses_other", "ses_grandparent", "worker"));
  const steer = createSteerModule({ ctx });
  const res = await steer.tools.steer.execute(
    { target: "ses_other", message: "hi" },
    { sessionID: "ses_parent" },
  );
  assert.equal(calls.prompts.length, 0, "non-child is never prompted");
  assert.match(res.content, /not a direct child/);
  assert.equal(res.metadata, undefined);
});

test("steer tool: unknown session id and unknown agent name are content-only refusals", async () => {
  const { ctx, calls } = makeCtx({ list: () => ({ data: [] }) });
  const steer = createSteerModule({ ctx });
  const missingID = await steer.tools.steer.execute(
    { target: "ses_missing", message: "hi" },
    { sessionID: "ses_parent" },
  );
  assert.match(missingID.content, /could not resolve session ses_missing/);
  const missingName = await steer.tools.steer.execute(
    { target: "sidekick", message: "hi" },
    { sessionID: "ses_parent" },
  );
  assert.equal(missingName.content, "steer: no child matching sidekick");
  assert.equal(calls.prompts.length, 0);
});

test("steer tool: agent name picks the only running child (record timing wins)", async () => {
  const now = Date.now();
  const { ctx, calls } = makeCtx({
    list: () => ({
      data: [
        // finished earlier: busy before idle
        childInfo("ses_done", "ses_parent", "sidekick", { busy: now - 5000, idle: now - 1000 }),
        // running now: busy after the last idle
        childInfo("ses_live", "ses_parent", "sidekick", { busy: now - 100, idle: now - 2000 }),
      ],
    }),
  });
  const steer = createSteerModule({ ctx });
  const res = await steer.tools.steer.execute(
    { target: "sidekick", message: "keep going" },
    { sessionID: "ses_parent" },
  );
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].sessionID, "ses_live");
  assert.equal(res.metadata.agent, "sidekick");
});

test("steer tool: multiple running matches by agent name are refused with the candidate ids", async () => {
  const now = Date.now();
  const { ctx, calls } = makeCtx({
    list: () => ({
      data: [
        childInfo("ses_a", "ses_parent", "sidekick", { busy: now - 10, idle: now - 2000 }),
        childInfo("ses_b", "ses_parent", "sidekick", { busy: now - 20, idle: now - 3000 }),
      ],
    }),
  });
  const steer = createSteerModule({ ctx });
  const res = await steer.tools.steer.execute(
    { target: "sidekick", message: "pick one" },
    { sessionID: "ses_parent" },
  );
  assert.equal(calls.prompts.length, 0, "ambiguity is never guessed");
  assert.match(res.content, /2 running children match sidekick/);
  assert.match(res.content, /ses_a/);
  assert.match(res.content, /ses_b/);
  assert.match(res.content, /Retarget by session id/);
});

test("steer tool: agent-name resolution falls back to tracked children when list is unavailable", async () => {
  const { ctx, calls, sessions } = makeCtx();
  sessions.set("ses_tracked", childInfo("ses_tracked", "ses_parent", "sidekick"));
  const steer = createSteerModule({ ctx });
  steer.handleEvent(createdProps("ses_tracked", "ses_parent"));
  const res = await steer.tools.steer.execute(
    { target: "sidekick", message: "from the tracker" },
    { sessionID: "ses_parent" },
  );
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].sessionID, "ses_tracked");
  assert.equal(res.metadata.targetSessionID, "ses_tracked");
});

test("report tool: writes one inbox line and mirrors live to the parent", async () => {
  const dir = inboxDir();
  const inbox = path.join(dir, "state", "fusion-inbox.jsonl");
  const { ctx, calls, sessions } = makeCtx();
  sessions.set("ses_child", childInfo("ses_child", "ses_parent", "sidekick"));
  const steer = createSteerModule({ ctx, inboxPath: inbox });
  const res = await steer.tools.report.execute(
    { message: "found a blocker: missing credentials", kind: "blocker", priority: "now" },
    { sessionID: "ses_child" },
  );
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].sessionID, "ses_parent");
  assert.equal(calls.prompts[0].delivery, "steer", "priority now delivers immediately");
  assert.equal(
    calls.prompts[0].text,
    "[report kind=blocker from=sidekick session=ses_child] found a blocker: missing credentials",
  );
  const lines = readFileSync(inbox, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry).sort(), [
    "agent",
    "fromSessionID",
    "kind",
    "message",
    "parentSessionID",
    "priority",
    "ts",
  ]);
  assert.equal(entry.parentSessionID, "ses_parent");
  assert.equal(entry.fromSessionID, "ses_child");
  assert.equal(entry.agent, "sidekick");
  assert.equal(entry.kind, "blocker");
  assert.equal(entry.priority, "now");
  assert.equal(entry.message, "found a blocker: missing credentials");
  assert.ok(!Number.isNaN(Date.parse(entry.ts)), "ts is an ISO timestamp");
  assert.deepEqual(res.metadata, {
    parentSessionID: "ses_parent",
    kind: "blocker",
    priority: "now",
    live: true,
  });
  rmSync(dir, { recursive: true, force: true });
});

test("report tool: defaults to note/next, queues, and never corrupts an existing inbox line", async () => {
  const dir = inboxDir();
  const inbox = path.join(dir, "fusion-inbox.jsonl");
  writeFileSync(inbox, '{"legacy":true}'); // deliberately no trailing newline
  const { ctx, calls, sessions } = makeCtx();
  sessions.set("ses_child", childInfo("ses_child", "ses_parent", "explore"));
  const steer = createSteerModule({ ctx, inboxPath: inbox });
  const res = await steer.tools.report.execute(
    { message: "the API was renamed" },
    { sessionID: "ses_child" },
  );
  assert.equal(calls.prompts[0].delivery, "queue", "priority next queues");
  assert.match(calls.prompts[0].text, /^\[report kind=note from=explore session=ses_child\] /);
  assert.equal(res.metadata.kind, "note");
  assert.equal(res.metadata.priority, "next");
  const lines = readFileSync(inbox, "utf8").split("\n");
  assert.equal(lines[lines.length - 1], "", "file still ends with a newline");
  const entries = lines.filter((l) => l !== "");
  assert.equal(entries.length, 2);
  assert.deepEqual(JSON.parse(entries[0]), { legacy: true }, "existing line intact");
  const entry = JSON.parse(entries[1]);
  assert.equal(entry.kind, "note");
  assert.equal(entry.priority, "next");
  assert.equal(entry.agent, "explore");
  rmSync(dir, { recursive: true, force: true });
});

test("report tool: a root session is told there is no orchestrator and nothing is sent", async () => {
  const dir = inboxDir();
  const inbox = path.join(dir, "fusion-inbox.jsonl");
  const { ctx, calls, sessions } = makeCtx();
  sessions.set("ses_root", { id: "ses_root", agent: "worker" });
  const steer = createSteerModule({ ctx, inboxPath: inbox });
  const res = await steer.tools.report.execute(
    { message: "context" },
    { sessionID: "ses_root" },
  );
  assert.equal(calls.prompts.length, 0);
  assert.match(res.content, /no orchestrator parent/);
  assert.match(res.content, /not sent/);
  assert.equal(existsSync(inbox), false, "no inbox line without an orchestrator");
  rmSync(dir, { recursive: true, force: true });
});

test("report tool: live failure keeps the inbox line and reports inbox-only delivery", async () => {
  const dir = inboxDir();
  const inbox = path.join(dir, "fusion-inbox.jsonl");
  const { ctx, sessions } = makeCtx({ failPrompt: "parent session busy" });
  sessions.set("ses_child", childInfo("ses_child", "ses_parent", "sidekick"));
  const steer = createSteerModule({ ctx, inboxPath: inbox });
  const res = await steer.tools.report.execute(
    { message: "still going", kind: "question", priority: "now" },
    { sessionID: "ses_child" },
  );
  assert.equal(res.metadata.live, false);
  assert.match(res.content, /inbox only/);
  assert.match(res.content, /parent session busy/);
  const lines = readFileSync(inbox, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "durable line survives the live failure");
  assert.equal(JSON.parse(lines[0]).kind, "question");
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------- /steer command target parsing

test("command: an agent-name target picks that child, not the most recent one", async () => {
  const now = Date.now();
  const { ctx, calls } = makeCtx({
    list: () => ({
      data: [
        childInfo("ses_side", "ses_parent", "sidekick", { busy: now - 100, idle: now - 2000 }),
        childInfo("ses_explore", "ses_parent", "explore", { busy: now - 50, idle: now - 3000 }),
      ],
    }),
  });
  const steer = createSteerModule({ ctx });
  const res = await steer.commandText("ses_parent", "/steer sidekick focus on the parser");
  assert.equal(res.ok, true);
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].sessionID, "ses_side", "agent target wins over recency");
  assert.equal(calls.prompts[0].text, "focus on the parser");
});

test("command: an idle-only agent match still receives the steer", async () => {
  const now = Date.now();
  const { ctx, calls } = makeCtx({
    list: () => ({
      data: [
        childInfo("ses_done", "ses_parent", "sidekick", { busy: now - 5000, idle: now - 1000 }),
      ],
    }),
  });
  const steer = createSteerModule({ ctx });
  const res = await steer.commandText("ses_parent", "/steer sidekick wrap up");
  assert.equal(res.ok, true);
  assert.equal(calls.prompts[0].sessionID, "ses_done");
});

test("command: session id and session-id prefix targets resolve direct children", async () => {
  const { ctx, calls, sessions } = makeCtx({
    list: () => ({
      data: [
        childInfo("ses_child", "ses_parent", "sidekick"),
        childInfo("ses_explore", "ses_parent", "explore"),
      ],
    }),
  });
  sessions.set("ses_child", childInfo("ses_child", "ses_parent", "sidekick"));
  const steer = createSteerModule({ ctx });
  const exact = await steer.commandText("ses_parent", "/steer ses_child check exact");
  assert.equal(exact.ok, true);
  assert.equal(calls.prompts[0].sessionID, "ses_child");
  const prefix = await steer.commandText("ses_parent", "/steer ses_exp check prefix");
  assert.equal(prefix.ok, true);
  assert.equal(calls.prompts[1].sessionID, "ses_explore");
});

test("command: unknown session prefix refuses and lists nothing to deliver", async () => {
  const { ctx, calls } = makeCtx({ list: () => ({ data: [] }) });
  const steer = createSteerModule({ ctx });
  const res = await steer.commandText("ses_parent", "/steer ses_missing focus");
  assert.equal(res.ok, false);
  assert.match(res.error, /could not resolve session ses_missing/);
  assert.equal(calls.prompts.length, 0);
  assert.match(lastSynthetic(calls).text, /could not resolve session ses_missing/);
});

test("command: an ambiguous session-id prefix lists candidates and delivers nothing", async () => {
  const { ctx, calls } = makeCtx({
    list: () => ({
      data: [
        childInfo("ses_ab1", "ses_parent", "sidekick"),
        childInfo("ses_ab2", "ses_parent", "explore"),
      ],
    }),
  });
  const steer = createSteerModule({ ctx });
  const res = await steer.commandText("ses_parent", "/steer ses_ab focus");
  assert.equal(res.ok, false);
  assert.match(res.error, /2 children match session ses_ab/);
  assert.match(res.error, /ses_ab1/);
  assert.match(res.error, /ses_ab2/);
  assert.equal(calls.prompts.length, 0, "ambiguity is never guessed");
  assert.match(lastSynthetic(calls).text, /Retarget by full session id/);
});

test("command: two running children with the same agent name are refused", async () => {
  const now = Date.now();
  const { ctx, calls } = makeCtx({
    list: () => ({
      data: [
        childInfo("ses_a", "ses_parent", "sidekick", { busy: now - 10, idle: now - 2000 }),
        childInfo("ses_b", "ses_parent", "sidekick", { busy: now - 20, idle: now - 3000 }),
      ],
    }),
  });
  const steer = createSteerModule({ ctx });
  const res = await steer.commandText("ses_parent", "/steer sidekick pick one");
  assert.equal(res.ok, false);
  assert.match(res.error, /2 running children match sidekick/);
  assert.equal(calls.prompts.length, 0);
});

test("command: a leading agent name with no matching child is part of the message", async () => {
  const { ctx, calls, sessions } = makeCtx();
  sessions.set("ses_e", childInfo("ses_e", "ses_parent", "explore"));
  const steer = createSteerModule({ ctx });
  steer.handleEvent(createdProps("ses_e", "ses_parent"));
  const res = await steer.commandText("ses_parent", "/steer sidekick needs to check the logs");
  assert.equal(res.ok, true);
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].sessionID, "ses_e");
  assert.equal(
    calls.prompts[0].text,
    "sidekick needs to check the logs",
    "no such child -> the whole input stays the message",
  );
});

// --------------------------------------------- steer channel notification

test("command delivery appends one channel-log line and one orchestrator aside", async () => {
  const dir = inboxDir();
  const inbox = path.join(dir, "fusion-inbox.jsonl");
  const now = Date.now();
  const { ctx, calls } = makeCtx({
    list: () => ({
      data: [
        childInfo("ses_child", "ses_parent", "sidekick", { busy: now - 10, idle: now - 2000 }),
      ],
    }),
  });
  const steer = createSteerModule({ ctx, inboxPath: inbox });
  const res = await steer.commandText("ses_parent", "/steer sidekick check the logs");
  assert.equal(res.ok, true);

  const lines = inboxLines(inbox);
  assert.equal(lines.length, 1);
  const entry = lines[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    "delivery",
    "message",
    "parentSessionID",
    "source",
    "targetAgent",
    "targetSessionID",
    "ts",
    "type",
  ]);
  assert.equal(entry.type, "steer");
  assert.equal(entry.parentSessionID, "ses_parent");
  assert.equal(entry.targetSessionID, "ses_child");
  assert.equal(entry.targetAgent, "sidekick");
  assert.equal(entry.source, "command");
  assert.equal(entry.delivery, "steer");
  assert.equal(entry.message, "check the logs");
  assert.ok(!Number.isNaN(Date.parse(entry.ts)), "ts is an ISO timestamp");

  assert.equal(calls.synthetics.length, 1, "exactly one aside, no duplicate confirmation");
  const aside = lastSynthetic(calls);
  assert.equal(aside.sessionID, "ses_parent");
  assert.equal(aside.metadata.fusionTools, "steer");
  assert.equal(aside.resume, false);
  assert.equal(
    aside.text,
    "steer delivered to sidekick (ses_child) via command: check the logs",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("tool delivery appends the channel-log line and the aside to the caller", async () => {
  const dir = inboxDir();
  const inbox = path.join(dir, "fusion-inbox.jsonl");
  const { ctx, calls, sessions } = makeCtx();
  sessions.set("ses_child", childInfo("ses_child", "ses_parent", "sidekick"));
  const steer = createSteerModule({ ctx, inboxPath: inbox });
  const res = await steer.tools.steer.execute(
    { target: "ses_child", message: "focus on the parser" },
    { sessionID: "ses_parent" },
  );
  assert.equal(res.metadata.targetSessionID, "ses_child");
  const entries = inboxLines(inbox);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "steer");
  assert.equal(entries[0].source, "tool");
  assert.equal(entries[0].targetAgent, "sidekick");
  assert.equal(entries[0].delivery, "steer");
  assert.equal(calls.synthetics.length, 1);
  assert.equal(
    lastSynthetic(calls).text,
    "steer delivered to sidekick (ses_child) via tool: focus on the parser",
  );
  assert.equal(lastSynthetic(calls).description, "steer tool");
  rmSync(dir, { recursive: true, force: true });
});

test("notification is best-effort: a failing aside never fails a delivered steer", async () => {
  const dir = inboxDir();
  const inbox = path.join(dir, "fusion-inbox.jsonl");
  const { ctx, calls, sessions } = makeCtx({ failSynthetic: "aside unavailable" });
  sessions.set("ses_child", childInfo("ses_child", "ses_parent", "sidekick"));
  const steer = createSteerModule({ ctx, inboxPath: inbox });

  const toolResult = await steer.tools.steer.execute(
    { target: "ses_child", message: "tool path" },
    { sessionID: "ses_parent" },
  );
  assert.match(toolResult.content, /steer delivered to sidekick \(ses_child\) via steer/);
  assert.equal(calls.prompts.length, 1, "the tool steer was delivered");

  const commandResult = await steer.commandText("ses_parent", "/steer ses_child command path");
  assert.equal(commandResult.ok, true);
  assert.equal(calls.prompts.length, 2, "the command steer was delivered");
  assert.equal(calls.synthetics.length, 0, "both asides failed and were swallowed");

  const entries = inboxLines(inbox);
  assert.equal(entries.length, 2, "durable lines survive aside failures");
  assert.deepEqual(
    entries.map((entry) => entry.source),
    ["tool", "command"],
  );
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ steer RPC

test("rpc: children lists direct children running first with agent and id", async () => {
  const now = Date.now();
  const { ctx } = makeCtx({
    list: () => ({
      data: [
        childInfo("ses_done", "ses_parent", "sidekick", { busy: now - 5000, idle: now - 1000 }),
        childInfo("ses_live", "ses_parent", "explore", { busy: now - 100, idle: now - 2000 }),
      ],
    }),
  });
  const steer = createSteerModule({ ctx });
  const rows = await steer.listChildrenForPicker("ses_parent");
  assert.deepEqual(rows, [
    { sessionID: "ses_live", agent: "explore", running: true },
    { sessionID: "ses_done", agent: "sidekick", running: false },
  ]);
});

test("rpc: deliver accepts raw command input and explicit picker targets", async () => {
  const dir = inboxDir();
  const inbox = path.join(dir, "fusion-inbox.jsonl");
  const now = Date.now();
  const { ctx, calls, sessions } = makeCtx({
    list: () => ({
      data: [
        childInfo("ses_child", "ses_parent", "sidekick", { busy: now - 10, idle: now - 2000 }),
      ],
    }),
  });
  const steer = createSteerModule({ ctx, inboxPath: inbox });

  const typed = await steer.deliverRpc({
    parentSessionID: "ses_parent",
    input: "sidekick from raw input",
    delivery: "steer",
    source: "command",
  });
  assert.equal(typed.ok, true);
  assert.equal(typed.targetSessionID, "ses_child");
  assert.equal(calls.prompts[0].text, "from raw input");

  const picked = await steer.deliverRpc({
    parentSessionID: "ses_parent",
    target: "ses_child",
    message: "from the picker",
    delivery: "steer",
    source: "command",
  });
  assert.equal(picked.ok, true);
  assert.equal(calls.prompts[1].sessionID, "ses_child");
  assert.equal(calls.prompts[1].delivery, "steer");
  assert.equal(calls.prompts[1].text, "from the picker");
  assert.equal(inboxLines(inbox).length, 2);
  assert.deepEqual(
    inboxLines(inbox).map((entry) => entry.message),
    ["from raw input", "from the picker"],
  );

  // Unknown agent: the RPC output must omit the field rather than send null
  // (the output schema is string-typed).
  sessions.set("ses_anon", { id: "ses_anon", parentID: "ses_parent" });
  const anon = await steer.deliverRpc({
    parentSessionID: "ses_parent",
    target: "ses_anon",
    message: "no agent label",
    source: "command",
  });
  assert.equal(anon.ok, true);
  assert.equal("agent" in anon, false, "null agent is omitted from the RPC output");
  rmSync(dir, { recursive: true, force: true });
});

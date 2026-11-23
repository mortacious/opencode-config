// subagent-cap tests: idempotent transform replay + loud no-match warning.
//
// Transforms replay on every tool-registry rebuild, so applying the transform
// twice must not stack wrappers: exactly one increment per call, one marker,
// one rejection path.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Error as ToolError } from "@opencode/plugin/promise/tool";

import { createCapState } from "../lib/cap.js";
import {
  claimSuccessLog,
  installCap,
  WRAPPED_MARKER,
} from "../lib/transform.js";

const QUIET = { log: () => {}, warn: () => {} };

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeEditor(tools) {
  const map = new Map(tools.map((tool) => [tool.id, tool]));
  return {
    map,
    editor: {
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
    },
  };
}

test("idempotent replay: two transform passes yield one wrapper", async () => {
  const state = createCapState({ cap: 3, profile: "cheap-local", getSession: async () => undefined });
  const gate = deferred();
  let originals = 0;
  const tool = {
    id: "task",
    name: "task",
    input: {},
    description: "fake spawn tool",
    execute: async () => {
      originals += 1;
      await gate.promise;
      return { content: "done" };
    },
  };
  const { editor, map } = makeEditor([tool]);

  installCap({ editor, toolIds: ["subagent", "task"], state, logger: QUIET });
  const firstWrapper = map.get("task").execute;
  installCap({ editor, toolIds: ["subagent", "task"], state, logger: QUIET });
  const secondWrapper = map.get("task").execute;

  assert.equal(secondWrapper, firstWrapper, "the second pass must not replace the wrapper");
  assert.equal(secondWrapper[WRAPPED_MARKER], true, "wrapper carries the own-property marker");

  const one = map.get("task").execute({}, {});
  assert.equal(state.count(), 1, "one increment per call, not two");

  const two = map.get("task").execute({}, {});
  const three = map.get("task").execute({}, {});
  assert.equal(state.count(), 3);

  await assert.rejects(map.get("task").execute({}, {}), (err) => {
    assert.ok(err instanceof ToolError);
    assert.match(err.message, /^subagent cap reached: 3\/3 running under profile "cheap-local"/);
    return true;
  });
  assert.equal(originals, 3, "no doubled execution from stacked wrappers");
  assert.equal(state.count(), 3);

  gate.resolve();
  await Promise.all([one, two, three]);
  assert.equal(state.count(), 0);
});

test("replay against a fresh base value wraps once more, not twice", async () => {
  const state = createCapState({ cap: 3, profile: "cheap-local", getSession: async () => undefined });
  const gate = deferred();
  const makeTool = () => ({
    id: "task",
    name: "task",
    input: {},
    description: "fake spawn tool",
    execute: async () => {
      await gate.promise;
      return { content: "done" };
    },
  });

  // First registry generation: transform applied once.
  const gen1 = makeEditor([makeTool()]);
  installCap({ editor: gen1.editor, toolIds: ["task"], state, logger: QUIET });
  const pending = gen1.map.get("task").execute({}, {});
  assert.equal(state.count(), 1);
  gate.resolve();
  await pending;
  assert.equal(state.count(), 0);

  // Rebuild: fresh base tool value, transform replayed.
  const gen2 = makeEditor([makeTool()]);
  installCap({ editor: gen2.editor, toolIds: ["task"], state, logger: QUIET });
  assert.equal(gen2.map.get("task").execute[WRAPPED_MARKER], true);
  const second = gen2.map.get("task").execute({}, {});
  assert.equal(state.count(), 1, "still one increment per call after replay");
  await second;
  assert.equal(state.count(), 0);
});

test("loud warning when no configured tool id matches", () => {
  const state = createCapState({ cap: 3, profile: "cheap-local", getSession: async () => undefined });
  const tool = {
    id: "some-other-tool",
    name: "some-other-tool",
    input: {},
    description: "unrelated",
    execute: async () => ({ content: "ok" }),
  };
  const { editor, map } = makeEditor([tool]);
  const warnings = [];
  const outcome = installCap({
    editor,
    toolIds: ["subagent", "task"],
    state,
    logger: { log: () => {}, warn: (msg) => warnings.push(msg) },
  });

  assert.deepEqual(outcome.wrapped, []);
  assert.deepEqual(outcome.availableIds, ["some-other-tool"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no subagent tool id matched/);
  assert.match(warnings[0], /"subagent","task"/);
  assert.match(warnings[0], /some-other-tool/);
  assert.equal(map.get("some-other-tool").execute[WRAPPED_MARKER], undefined, "tool left untouched");
});

test("idempotent logs: the no-match warning is emitted once per pattern/registry pair", () => {
  const state = createCapState({ cap: 3, profile: "cheap-local", getSession: async () => undefined });
  const tool = {
    id: "other-tool-x",
    name: "other-tool-x",
    input: {},
    description: "unrelated",
    execute: async () => ({ content: "ok" }),
  };
  const warnings = [];
  const logger = { log: () => {}, warn: (msg) => warnings.push(msg) };

  const first = makeEditor([tool]);
  installCap({ editor: first.editor, toolIds: ["subagent", "task"], state, logger });
  installCap({ editor: first.editor, toolIds: ["subagent", "task"], state, logger });
  assert.equal(warnings.length, 1, "a replay must not repeat the warning");

  // A changed registry re-warns so a still-unmatched config stays visible.
  const second = makeEditor([tool, { ...tool, id: "yet-another-tool" }]);
  installCap({ editor: second.editor, toolIds: ["subagent", "task"], state, logger });
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /yet-another-tool/);
});

test("idempotent logs: the success line is claimed once per pattern", () => {
  assert.equal(claimSuccessLog(["subagent", "task"], ["task"]), true);
  assert.equal(claimSuccessLog(["subagent", "task"], ["task"]), false, "replay is silent");
  assert.equal(claimSuccessLog(["subagent", "task"], ["subagent", "task"]), true, "new id set");
});

test("blocked spawn mirrors the block message into Tool.Error metadata", async () => {
  const state = createCapState({ cap: 1, profile: "cheap-local", getSession: async () => undefined });
  const gate = deferred();
  const tool = {
    id: "task",
    name: "task",
    input: {},
    description: "fake spawn tool",
    execute: async () => {
      await gate.promise;
      return { content: "done" };
    },
  };
  const { editor, map } = makeEditor([tool]);
  installCap({ editor, toolIds: ["subagent", "task"], state, logger: QUIET });

  const held = map.get("task").execute({}, {});
  assert.equal(state.count(), 1);
  const err = await map.get("task").execute({}, {}).then(
    () => null,
    (thrown) => thrown
  );
  assert.ok(err instanceof ToolError, "blocked call rejects with Tool.Error");
  assert.equal(err.metadata.subagentCap, err.message, "text survives in metadata");
  assert.match(err.message, /^subagent cap reached: 1\/1 running under profile "cheap-local"/);

  gate.resolve();
  await held;
  assert.equal(state.count(), 0);
});

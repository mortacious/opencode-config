import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCellsHandler,
  createKernelNotifier,
  createKernelTools,
  normalizeCellLimit,
} from "../index.js";
import { Kernel } from "../rpc.js";

const CTX = { sessionID: "ses_test" };

const CELL = (count, source = `cell-${count}`) => ({
  v: 1,
  type: "cell",
  execution_count: count,
  source,
  outputs: [],
  truncated: false,
});

const META = {
  v: 1,
  kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
  language_info: { name: "python" },
  selection: "/usr/bin/python3",
  cells: 2,
  truncated: false,
};

function makePaths(base, sessionID = CTX.sessionID) {
  const dir = path.join(base, sessionID);
  return {
    dir,
    imagesDir: path.join(dir, "images"),
    logsDir: path.join(dir, "logs"),
    journal: path.join(dir, "cells.jsonl"),
    meta: path.join(dir, "meta.json"),
  };
}

async function tempBase() {
  return mkdtemp(path.join(os.tmpdir(), "kernel-rpc-"));
}

test("definition exposes the kernel id, cells method and both events", () => {
  assert.equal(Kernel.id, "kernel");
  assert.deepEqual(Object.keys(Kernel.methods), ["cells"]);
  assert.deepEqual(Kernel.methods.cells.input.required, ["sessionID"]);
  assert.deepEqual(Object.keys(Kernel.events).sort(), ["cell", "reset"]);
  assert.equal(Kernel.events.cell.schema.type, "object");
  assert.equal(Kernel.events.reset.schema.type, "object");
});

test("normalizeCellLimit defaults to 100 and caps at 500", () => {
  assert.equal(normalizeCellLimit(undefined), 100);
  assert.equal(normalizeCellLimit(Number.NaN), 100);
  assert.equal(normalizeCellLimit(7.9), 7);
  assert.equal(normalizeCellLimit(0), 1);
  assert.equal(normalizeCellLimit(10_000), 500);
});

test("cells reads meta and returns the journal records", async () => {
  const base = await tempBase();
  const paths = makePaths(base);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.meta, `${JSON.stringify(META)}\n`);
  await writeFile(
    paths.journal,
    `${JSON.stringify(CELL(1))}\n${JSON.stringify({ v: 1, type: "boundary", text: "Kernel reset" })}\n${JSON.stringify(CELL(2))}\n`,
  );

  const handler = createCellsHandler({
    pathsForSession: (sessionID) => makePaths(base, sessionID),
  });
  const result = await handler({ sessionID: CTX.sessionID });

  assert.deepEqual(result.meta, META);
  assert.equal(result.cells.length, 3);
  assert.equal(result.cells[2].execution_count, 2);
});

test("cells returns only the last limit records", async () => {
  const base = await tempBase();
  const paths = makePaths(base);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.journal,
    [CELL(1), CELL(2), CELL(3)].map((cell) => `${JSON.stringify(cell)}\n`).join(""),
  );

  const handler = createCellsHandler({
    pathsForSession: (sessionID) => makePaths(base, sessionID),
  });

  const two = await handler({ sessionID: CTX.sessionID, limit: 2 });
  assert.deepEqual(two.cells.map((cell) => cell.execution_count), [2, 3]);

  const capped = await handler({ sessionID: CTX.sessionID, limit: 900 });
  assert.deepEqual(capped.cells.map((cell) => cell.execution_count), [1, 2, 3]);
});

test("cells defaults to 100 records", async () => {
  const base = await tempBase();
  const paths = makePaths(base);
  await mkdir(paths.dir, { recursive: true });
  const lines = [];
  for (let count = 1; count <= 130; count += 1) {
    lines.push(`${JSON.stringify(CELL(count))}\n`);
  }
  await writeFile(paths.journal, lines.join(""));

  const handler = createCellsHandler({
    pathsForSession: (sessionID) => makePaths(base, sessionID),
  });
  const result = await handler({ sessionID: CTX.sessionID });

  assert.equal(result.cells.length, 100);
  assert.equal(result.cells[0].execution_count, 31);
});

test("cells on a new session returns null meta and no cells", async () => {
  const base = await tempBase();
  const handler = createCellsHandler({
    pathsForSession: (sessionID) => makePaths(base, sessionID),
  });

  const result = await handler({ sessionID: CTX.sessionID });

  assert.deepEqual(result, { meta: null, cells: [] });
});

test("cells rejects an invalid session id", async () => {
  const handler = createCellsHandler();

  await assert.rejects(handler({ sessionID: "" }), /requires a session id/);
  await assert.rejects(handler({ sessionID: "../escape" }), /invalid session id/);
});

test("notifier emits reset then the latest cell record", async () => {
  const base = await tempBase();
  const paths = makePaths(base);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.journal,
    `${JSON.stringify(CELL(1))}\n${JSON.stringify(CELL(2))}\n`,
  );
  const emitted = [];
  const registration = {
    dispose: async () => {},
    events: {
      emit: async (name, data) => {
        emitted.push({ name, data });
      },
    },
  };
  const notify = createKernelNotifier({
    registration,
    pathsForSession: (sessionID) => makePaths(base, sessionID),
  });

  await notify({
    sessionID: CTX.sessionID,
    reset: true,
    selection: "/usr/bin/python3",
    wroteCell: true,
  });

  assert.deepEqual(emitted.map((event) => event.name), ["reset", "cell"]);
  assert.deepEqual(emitted[0].data, { selection: "/usr/bin/python3" });
  assert.deepEqual(emitted[1].data, CELL(2));
});

test("notifier defers a reset-only divider to just before the next cell", async () => {
  const emitted = [];
  const registration = {
    events: {
      emit: async (name, data) => {
        emitted.push({ name, data });
      },
    },
  };
  const notify = createKernelNotifier({
    registration,
    read: async () => ({ meta: null, cells: [CELL(1)] }),
  });

  // The reset-only call writes no journal cell, so the panel cannot see the
  // boundary yet. The next normal call re-emits reset before its cell event.
  await notify({
    sessionID: CTX.sessionID,
    reset: true,
    selection: "/usr/bin/python3",
    wroteCell: false,
  });
  await notify({
    sessionID: CTX.sessionID,
    reset: false,
    selection: "/usr/bin/python3",
    wroteCell: true,
  });

  const names = emitted.map((event) => event.name);
  assert.deepEqual(names, ["reset", "reset", "cell"]);
  assert.ok(
    names.lastIndexOf("reset") < names.indexOf("cell"),
    "the deferred reset must precede the cell event",
  );
  assert.deepEqual(emitted[1].data, { selection: "/usr/bin/python3" });
  assert.deepEqual(emitted[2].data, CELL(1));
});

test("notifier without a registration is a no-op and never throws", async () => {
  const notify = createKernelNotifier({
    read: async () => {
      throw new Error("must not read");
    },
  });

  await notify({ sessionID: CTX.sessionID, reset: true, wroteCell: true });
});

test("notifier swallows emit failures", async () => {
  const registration = {
    events: {
      emit: async () => {
        throw new Error("socket closed");
      },
    },
  };
  const notify = createKernelNotifier({
    registration,
    read: async () => ({ meta: null, cells: [CELL(1)] }),
  });

  await notify({ sessionID: CTX.sessionID, reset: false, wroteCell: true });
});

function makeHost(options, journalFile) {
  const selection = options.args[options.args.indexOf("--kernel") + 1];
  const host = {
    selection,
    execCalls: [],
    shutdownCalls: 0,
    exec: async (call) => {
      host.execCalls.push(call);
      const count = host.execCalls.length;
      if (call.code !== "") {
        await appendFile(
          journalFile,
          `${JSON.stringify(CELL(count, call.code))}\n`,
        );
      }
      return { status: "ok", executionCount: count, lost: false };
    },
    shutdown: async () => {
      host.shutdownCalls += 1;
      return { code: 0, signal: null };
    },
    interrupt: () => true,
  };
  return host;
}

async function toolSetup() {
  const base = await tempBase();
  const journalFile = makePaths(base).journal;
  const emitted = [];
  const registration = {
    dispose: async () => {},
    events: {
      emit: async (name, data) => {
        emitted.push({ name, data });
      },
    },
  };
  const pathsForSession = (sessionID) => makePaths(base, sessionID);

  const tools = createKernelTools({
    createHost: (options) => makeHost(options, journalFile),
    resolveSelection: async ({ requested }) => ({
      kind: requested.startsWith("/") ? "python" : "kernelspec",
      selection: requested === "" ? "/usr/bin/python3" : requested,
      hostPython: "python3",
    }),
    resolveProjectDir: async () => "/project",
    pathsForSession,
    env: {},
    hostScript: "/plugin/host.py",
    onExecuted: createKernelNotifier({ registration, pathsForSession }),
  });

  return { tools, emitted, journalFile };
}

test("a successful tool call emits cell; reset emits reset then cell", async () => {
  const { tools, emitted } = await toolSetup();

  await tools.tools.kernel.execute({ code: "1 + 1" }, CTX);
  assert.deepEqual(emitted.map((event) => event.name), ["cell"]);
  assert.equal(emitted[0].data.source, "1 + 1");

  await tools.tools.kernel.execute(
    { code: "2 + 2", reset: true, kernel: "/other/python" },
    CTX,
  );
  assert.deepEqual(emitted.map((event) => event.name), [
    "cell",
    "reset",
    "cell",
  ]);
  assert.deepEqual(emitted[1].data, { selection: "/other/python" });
  assert.equal(emitted[2].data.source, "2 + 2");

  await tools.shutdown();
});

test("a reset-only call emits reset without a cell", async () => {
  const { tools, emitted } = await toolSetup();

  await tools.tools.kernel.execute({ code: "1" }, CTX);
  await tools.tools.kernel.execute({ reset: true }, CTX);

  const names = emitted.map((event) => event.name);
  assert.deepEqual(names, ["cell", "reset"]);
  assert.deepEqual(emitted[1].data, { selection: "/usr/bin/python3" });

  await tools.shutdown();
});

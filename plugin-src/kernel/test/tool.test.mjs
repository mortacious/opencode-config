import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addKernelTools,
  createKernelTools,
  resolveProjectDirectory,
} from "../index.js";

const CTX = { sessionID: "ses_test" };

function makeHost(options, index) {
  const selection = options.args[options.args.indexOf("--kernel") + 1];
  const host = {
    index,
    options,
    selection,
    execCalls: [],
    shutdownCalls: 0,
    interrupts: 0,
    exited: false,
    pid: 2000 + index,
    hold: null,
    script: null,
  };

  host.exec = async (call) => {
    host.execCalls.push(call);
    if (host.hold) await host.hold;
    const events = host.script
      ? host.script(call)
      : [
          { op: "stream", id: call.id, name: "stdout", text: `run:${call.code}\n` },
          {
            op: "result",
            id: call.id,
            executionCount: host.execCalls.length,
            data: { "text/plain": String(call.code) },
          },
          {
            op: "done",
            id: call.id,
            status: "ok",
            executionCount: host.execCalls.length,
          },
        ];
    for (const event of events) options.onEvent(event);
    const done = events.find((event) => event.op === "done");
    return {
      status: done?.status ?? "ok",
      executionCount: done?.executionCount ?? host.execCalls.length,
      lost: false,
    };
  };

  host.shutdown = async () => {
    host.shutdownCalls += 1;
    host.exited = true;
    return { code: 0, signal: null };
  };
  host.interrupt = () => {
    host.interrupts += 1;
    return true;
  };

  return host;
}

async function until(predicate, label = "condition") {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function setup({ exportRunner, hold = null, script = null } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "kernel-tool-"));
  const hosts = [];
  const exports = [];

  const createHost = (options) => {
    const host = makeHost(options, hosts.length);
    host.hold = hold;
    host.script = script;
    hosts.push(host);
    return host;
  };

  const pathsForSession = (sessionID) => {
    const dir = path.join(base, sessionID);
    return {
      dir,
      imagesDir: path.join(dir, "images"),
      logsDir: path.join(dir, "logs"),
      journal: path.join(dir, "cells.jsonl"),
      meta: path.join(dir, "meta.json"),
    };
  };

  const tools = createKernelTools({
    createHost,
    resolveSelection: async ({ requested }) => ({
      kind: requested.startsWith("/") ? "python" : "kernelspec",
      selection: requested === "" ? "/usr/bin/python3" : requested,
      hostPython: "python3",
    }),
    resolveProjectDir: async () => "/project",
    pathsForSession,
    exportRunner:
      exportRunner ??
      (async (args) => {
        exports.push(args);
        return { ok: true, path: args.out, cells: 2, truncated: false };
      }),
    env: {},
    hostScript: "/plugin/host.py",
  });

  return { base, hosts, exports, tools, pathsForSession };
}

test("both tools register with codemode disabled", async () => {
  const { tools } = await setup();
  const editor = {
    added: [],
    add(tool) {
      this.added.push(tool);
    },
  };

  addKernelTools(editor, tools.tools);

  assert.deepEqual(
    editor.added.map((tool) => tool.name),
    ["kernel", "kernel_export"],
  );
  for (const tool of editor.added) {
    assert.equal(tool.options.codemode, false);
    assert.equal(tool.input.type, "object");
    assert.equal(tool.input.additionalProperties, false);
  }
  assert.deepEqual(tools.tools.kernel_export.input.required, ["path"]);
});

test("kernel rejects a call with no code and no reset", async () => {
  const { tools } = await setup();
  await assert.rejects(
    tools.tools.kernel.execute({}, CTX),
    /no cell to run; pass code or reset:true/,
  );
});

test("kernel rejects a kernel switch without reset", async () => {
  const { tools } = await setup();
  await tools.tools.kernel.execute({ code: "1" }, CTX);

  await assert.rejects(
    tools.tools.kernel.execute({ code: "2", kernel: "/other/python" }, CTX),
    /selection changed from \/usr\/bin\/python3 to \/other\/python; pass reset:true/,
  );
});

test("kernel rejects a second cell while one is running", async () => {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const { tools } = await setup({ hold });

  const first = tools.tools.kernel.execute({ code: "1" }, CTX);
  await until(() => tools.registry.get(CTX.sessionID)?.busy === true, "busy entry");

  await assert.rejects(
    tools.tools.kernel.execute({ code: "2" }, CTX),
    /a cell is already running in this session/,
  );

  release();
  await first;
  assert.equal(tools.registry.get(CTX.sessionID)?.busy, false);
});

test("concurrent cells spawn one host and reject the second as busy", async () => {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const { tools, hosts } = await setup({ hold });

  const first = tools.tools.kernel.execute({ code: "1" }, CTX);
  const second = tools.tools.kernel.execute({ code: "2" }, CTX);

  await assert.rejects(second, /a cell is already running in this session/);
  assert.equal(tools.registry.get(CTX.sessionID)?.busy, true);

  release();
  await first;
  assert.equal(hosts.length, 1);
  assert.equal(tools.registry.get(CTX.sessionID)?.busy, false);
});

test("reset with the same selection restarts the live host and confirms", async () => {
  const { tools, hosts } = await setup();
  await tools.tools.kernel.execute({ code: "1" }, CTX);

  const result = await tools.tools.kernel.execute({ reset: true }, CTX);

  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].execCalls.length, 2);
  assert.equal(hosts[0].execCalls[1].reset, true);
  assert.equal(hosts[0].execCalls[1].code, "");
  assert.equal(result.content, "Kernel reset: /usr/bin/python3");
  assert.deepEqual(result.metadata, {
    status: "reset",
    kernel: "/usr/bin/python3",
    executionCount: 0,
  });
});

test("reset with a new kernel shuts down the old host and starts a blank one", async () => {
  const { tools, hosts } = await setup();
  await tools.tools.kernel.execute({ code: "1" }, CTX);

  const result = await tools.tools.kernel.execute(
    { reset: true, kernel: "/other/python", code: "2" },
    CTX,
  );

  assert.equal(hosts.length, 2);
  assert.equal(hosts[0].shutdownCalls, 1);
  assert.equal(hosts[1].selection, "/other/python");
  assert.equal(hosts[1].execCalls[0].reset, false);
  assert.equal(result.metadata.kernel, "/other/python");
});

test("reset on a fresh session starts a host and confirms", async () => {
  const { tools, hosts } = await setup();
  const result = await tools.tools.kernel.execute({ reset: true }, CTX);

  assert.equal(result.content, "Kernel reset: /usr/bin/python3");
  assert.deepEqual(result.metadata, {
    status: "reset",
    kernel: "/usr/bin/python3",
    executionCount: 0,
  });
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].execCalls.length, 0);
});

test("an aborted call interrupts the host", async () => {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const { tools, hosts } = await setup({ hold });
  const controller = new AbortController();

  const pending = tools.tools.kernel.execute(
    { code: "while True: pass" },
    { ...CTX, signal: controller.signal },
  );
  await until(() => hosts.length === 1, "host start");

  controller.abort();
  await until(() => hosts[0].interrupts === 1, "interrupt");

  release();
  await pending;
});

test("image outputs return a text part plus an inline file part", async () => {
  const payload = Buffer.from("PNGDATA");
  const { tools, base } = await setup({
    script: (call) => [
      {
        op: "display",
        id: call.id,
        data: {
          "text/plain": "<Figure size 640x480>",
          "image/png": payload.toString("base64"),
        },
      },
      { op: "done", id: call.id, status: "ok", executionCount: 3 },
    ],
  });

  const result = await tools.tools.kernel.execute({ code: "fig()" }, CTX);
  const expected = path.join(base, "ses_test", "images", "3-1.png");

  assert.ok(Array.isArray(result.content), result.content);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: `In[3]\n<Figure size 640x480>\nimage: ${expected}\n`,
    },
    {
      type: "file",
      uri: `data:image/png;base64,${payload.toString("base64")}`,
      mime: "image/png",
      name: "3-1.png",
    },
  ]);
  assert.deepEqual(result.metadata.images, [expected]);
  assert.equal(result.metadata.logPath, null);
  assert.equal(result.metadata.truncated, false);
  assert.equal(result.metadata.status, "ok");
  assert.equal(result.metadata.executionCount, 3);
  assert.equal(result.metadata.kernel, "/usr/bin/python3");
  assert.equal(result.metadata.sessionID, "ses_test");
  assert.deepEqual(await readFile(expected), payload);
});

test("a cell without images keeps plain text content", async () => {
  const { tools } = await setup();
  const result = await tools.tools.kernel.execute({ code: "1" }, CTX);

  assert.equal(typeof result.content, "string");
  assert.equal(result.content, "In[1]\nrun:1\nOut[1]: 1\n");
  assert.deepEqual(result.metadata.images, []);
});

test("output over 50 KiB is truncated to a log file", async () => {
  const body = "z".repeat(60000);
  const { tools, base } = await setup({
    script: (call) => [
      { op: "stream", id: call.id, name: "stdout", text: body },
      { op: "done", id: call.id, status: "ok", executionCount: 9 },
    ],
  });

  const result = await tools.tools.kernel.execute({ code: "big()" }, CTX);
  const expectedLog = path.join(base, "ses_test", "logs", "cell-9.log");

  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.logPath, expectedLog);
  assert.ok(
    result.content.includes(`[truncated at 51200 bytes; full log: ${expectedLog}]`),
    result.content.slice(-120),
  );
  assert.equal(await readFile(expectedLog, "utf8"), `In[9]\n${body}`);
});

test("kernel_export resolves relative paths and appends .ipynb", async () => {
  const { tools, exports, base } = await setup();
  const result = await tools.tools.kernel_export.execute(
    { path: "reports/run", title: "Run" },
    CTX,
  );

  assert.equal(result.content, "Exported 2 cells to /project/reports/run.ipynb");
  assert.deepEqual(result.metadata, {
    path: "/project/reports/run.ipynb",
    cells: 2,
    truncated: false,
  });
  assert.equal(exports.length, 1);
  assert.equal(exports[0].python, "python3");
  assert.equal(exports[0].hostScript, "/plugin/host.py");
  assert.equal(exports[0].out, "/project/reports/run.ipynb");
  assert.equal(exports[0].journal, path.join(base, "ses_test", "cells.jsonl"));
  assert.equal(exports[0].meta, path.join(base, "ses_test", "meta.json"));
  assert.equal(exports[0].title, "Run");
});

test("kernel_export preserves an absolute .ipynb path", async () => {
  const { tools, exports } = await setup();
  await tools.tools.kernel_export.execute({ path: "/tmp/abs.ipynb" }, CTX);
  assert.equal(exports[0].out, "/tmp/abs.ipynb");
});

test("kernel_export refuses while a cell is running", async () => {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const { tools } = await setup({ hold });

  const running = tools.tools.kernel.execute({ code: "1" }, CTX);
  await until(() => tools.registry.get(CTX.sessionID)?.busy === true, "busy entry");

  await assert.rejects(
    tools.tools.kernel_export.execute({ path: "run" }, CTX),
    /a cell is already running in this session; export after it finishes/,
  );

  release();
  await running;
});

test("kernel_export works after the session host was evicted", async () => {
  const { tools, hosts } = await setup();
  await tools.tools.kernel.execute({ code: "1" }, CTX);

  await tools.registry.delete(CTX.sessionID);
  assert.equal(hosts[0].shutdownCalls, 1);

  const result = await tools.tools.kernel_export.execute({ path: "run" }, CTX);
  assert.match(result.content, /Exported 2 cells to \/project\/run\.ipynb/);
});

test("kernel_export surfaces the empty-journal host error", async () => {
  const { tools } = await setup({
    exportRunner: async () => {
      throw new Error("session has no recorded cells; nothing written");
    },
  });

  await assert.rejects(
    tools.tools.kernel_export.execute({ path: "run" }, CTX),
    /session has no recorded cells; nothing written/,
  );
});

test("kernel_export requires a path", async () => {
  const { tools } = await setup();
  await assert.rejects(
    tools.tools.kernel_export.execute({}, CTX),
    /kernel_export requires a path/,
  );
});

test("session.deleted evicts the session host", async () => {
  const { tools, hosts } = await setup();
  await tools.tools.kernel.execute({ code: "1" }, CTX);

  tools.handleEvent({ type: "session.deleted", data: { sessionID: CTX.sessionID } });
  await until(() => hosts[0].shutdownCalls === 1, "host shutdown");

  assert.equal(tools.registry.get(CTX.sessionID), undefined);
});

test("resolveProjectDirectory reads the session record then falls back", async () => {
  const fromSession = {
    session: {
      get: async ({ sessionID }) => ({
        data: { location: { directory: `/sessions/${sessionID}` } },
      }),
    },
  };
  assert.equal(
    await resolveProjectDirectory(fromSession, "ses_a"),
    "/sessions/ses_a",
  );

  const failing = {
    session: {
      get: async () => {
        throw new Error("unavailable");
      },
    },
    location: { directory: "/location" },
  };
  assert.equal(await resolveProjectDirectory(failing, "ses_a"), "/location");

  assert.equal(await resolveProjectDirectory({}, "ses_a"), process.cwd());
});

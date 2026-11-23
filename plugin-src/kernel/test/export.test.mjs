import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  defaultExportPython,
  exportArgs,
  exportNotebook,
} from "../lib/export.js";

function fakeSpawn({ stdout = "", stderr = "", code = 0, startError = null } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setTimeout(() => {
      if (startError) {
        child.emit("error", startError);
        return;
      }
      if (stdout !== "") child.stdout.write(stdout);
      if (stderr !== "") child.stderr.write(stderr);
      child.emit("close", code);
    }, 0);
    return child;
  };
  return { spawn, calls };
}

const BASE = {
  hostScript: "/plugin/host.py",
  journal: "/state/ses/cells.jsonl",
  meta: "/state/ses/meta.json",
  out: "/project/out.ipynb",
};

test("spawns python with the export-only host protocol and parses JSON", async () => {
  const { spawn, calls } = fakeSpawn({
    stdout: `${JSON.stringify({ ok: true, path: "/project/out.ipynb", cells: 3, truncated: false })}\n`,
  });

  const result = await exportNotebook({
    ...BASE,
    python: "/venv/bin/python",
    title: "Session",
    spawn,
  });

  assert.deepEqual(result, {
    ok: true,
    path: "/project/out.ipynb",
    cells: 3,
    truncated: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/venv/bin/python");
  assert.deepEqual(calls[0].args, [
    "-u",
    "/plugin/host.py",
    "--export-only",
    "--journal",
    "/state/ses/cells.jsonl",
    "--meta",
    "/state/ses/meta.json",
    "--out",
    "/project/out.ipynb",
    "--title",
    "Session",
  ]);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
});

test("omits --title when none is supplied", () => {
  const args = exportArgs(BASE);
  assert.deepEqual(args, [
    "-u",
    "/plugin/host.py",
    "--export-only",
    "--journal",
    "/state/ses/cells.jsonl",
    "--meta",
    "/state/ses/meta.json",
    "--out",
    "/project/out.ipynb",
  ]);
});

test("uses PYTHON_EXPORT or python3 by default", async () => {
  assert.equal(defaultExportPython({}), "python3");
  assert.equal(defaultExportPython({ PYTHON_EXPORT: "/opt/py" }), "/opt/py");

  const previous = process.env.PYTHON_EXPORT;
  delete process.env.PYTHON_EXPORT;
  try {
    const { spawn, calls } = fakeSpawn({
      stdout: `${JSON.stringify({ ok: true, path: BASE.out, cells: 1, truncated: true })}\n`,
    });
    const result = await exportNotebook({ ...BASE, spawn });
    assert.equal(calls[0].command, "python3");
    assert.equal(result.truncated, true);
  } finally {
    if (previous !== undefined) process.env.PYTHON_EXPORT = previous;
  }
});

test("parses the last JSON line when the host prints noise first", async () => {
  const { spawn } = fakeSpawn({
    stdout: `warning: something\n${JSON.stringify({ ok: true, path: BASE.out, cells: 2 })}\n`,
  });
  const result = await exportNotebook({ ...BASE, spawn });
  assert.equal(result.cells, 2);
  assert.equal(result.truncated, false);
});

test("throws the host error when export reports failure", async () => {
  const { spawn } = fakeSpawn({
    code: 1,
    stdout: `${JSON.stringify({ ok: false, error: "session has no recorded cells; nothing written" })}\n`,
  });

  await assert.rejects(
    exportNotebook({ ...BASE, spawn }),
    /session has no recorded cells; nothing written/,
  );
});

test("rejects an exit without a valid JSON line", async () => {
  const { spawn } = fakeSpawn({ code: 1, stdout: "not json\n", stderr: "traceback here\n" });
  await assert.rejects(
    exportNotebook({ ...BASE, spawn }),
    /kernel export failed: traceback here/,
  );
});

test("rejects when the interpreter cannot be spawned", async () => {
  const { spawn } = fakeSpawn({ startError: new Error("ENOENT") });
  await assert.rejects(
    exportNotebook({ ...BASE, spawn }),
    /kernel export failed to start: ENOENT/,
  );
});

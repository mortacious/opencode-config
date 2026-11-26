import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const HOST = path.join(import.meta.dirname, "..", "host.py");
const PYTHON = "python3";
const CELL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kernel-export-"));
}

function runExport(dir, { journal = "cells.jsonl", out = "out.ipynb", title = "Demo" } = {}) {
  const args = ["-u", HOST, "--export-only", "--journal", path.join(dir, journal)];
  const metaPath = path.join(dir, "meta.json");
  if (fs.existsSync(metaPath)) args.push("--meta", metaPath);
  args.push("--out", path.join(dir, out));
  if (title) args.push("--title", title);
  return spawnSync(PYTHON, args, { encoding: "utf-8", timeout: 30000 });
}

function writeFixtures(dir) {
  const cells = [
    {
      v: 1,
      type: "cell",
      execution_count: 1,
      source: "print('hi')\n",
      outputs: [{ output_type: "stream", name: "stdout", text: "hi\n" }],
      truncated: false,
    },
    { v: 1, type: "boundary", text: "Kernel reset" },
    {
      v: 1,
      type: "cell",
      execution_count: 2,
      source: "figure()\n",
      outputs: [
        {
          output_type: "execute_result",
          execution_count: 2,
          data: { "image/png": PNG, "text/plain": "<Figure>" },
          metadata: {},
        },
      ],
      truncated: false,
    },
    {
      v: 1,
      type: "cell",
      execution_count: 3,
      source: "raise ValueError('boom')\n",
      outputs: [
        {
          output_type: "error",
          ename: "ValueError",
          evalue: "boom",
          traceback: ["ValueError: boom"],
        },
      ],
      truncated: false,
    },
  ];
  fs.writeFileSync(
    path.join(dir, "cells.jsonl"),
    cells.map((cell) => JSON.stringify(cell)).join("\n") + "\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        v: 1,
        kernelspec: { name: "demo", display_name: "Demo", language: "python" },
        language_info: { name: "python", version: "3.12.0" },
        selection: "/usr/bin/python3",
        cells: 3,
        truncated: false,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

function tempFilesIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes(".nb-export-"));
}

test("export-only writes a valid nbformat 4.5 notebook with unique cell ids", (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFixtures(dir);

  const result = runExport(dir);
  assert.equal(result.status, 0, result.stderr);

  const outPath = path.join(dir, "out.ipynb");
  const notebook = JSON.parse(fs.readFileSync(outPath, "utf-8"));

  assert.equal(notebook.nbformat, 4);
  assert.equal(notebook.nbformat_minor, 5);
  assert.deepEqual(notebook.metadata.kernelspec, {
    name: "demo",
    display_name: "Demo",
    language: "python",
  });

  const ids = notebook.cells.map((cell) => cell.id);
  assert.equal(ids.length, 5);
  for (const id of ids) {
    assert.equal(typeof id, "string");
    assert.match(id, CELL_ID);
  }
  assert.equal(new Set(ids).size, ids.length, "cell ids must be unique");

  const [title, first, boundary, second, third] = notebook.cells;

  assert.equal(title.cell_type, "markdown");
  assert.equal(title.source.join(""), "# Demo");

  assert.equal(first.cell_type, "code");
  assert.equal(first.source.join(""), "print('hi')\n");
  assert.deepEqual(first.outputs, [
    { output_type: "stream", name: "stdout", text: "hi\n" },
  ]);

  assert.equal(boundary.cell_type, "markdown");
  assert.equal(boundary.source.join(""), "## Kernel reset");

  assert.equal(second.cell_type, "code");
  assert.equal(second.outputs.length, 1);
  const image = second.outputs[0];
  assert.equal(image.output_type, "execute_result");
  assert.equal(image.execution_count, 2);
  assert.equal(image.data["image/png"], PNG);
  assert.ok(
    Buffer.from(image.data["image/png"], "base64").equals(
      Buffer.from(PNG, "base64"),
    ),
    "image bytes must round-trip",
  );

  assert.equal(third.cell_type, "code");
  assert.deepEqual(third.outputs, [
    {
      output_type: "error",
      ename: "ValueError",
      evalue: "boom",
      traceback: ["ValueError: boom"],
    },
  ]);

  assert.deepEqual(tempFilesIn(dir), []);
});

test("empty journal fails without writing a notebook", (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "cells.jsonl"), "", "utf-8");

  const result = runExport(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"ok": false/);
  assert.match(result.stdout, /session has no recorded cells; nothing written/);
  assert.equal(fs.existsSync(path.join(dir, "out.ipynb")), false);
  assert.deepEqual(tempFilesIn(dir), []);
});

test("ignores a final unterminated journal line but fails on malformed complete lines", (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cell = {
    v: 1,
    type: "cell",
    execution_count: 1,
    source: "1 + 1\n",
    outputs: [{ output_type: "execute_result", execution_count: 1, data: { "text/plain": "2" }, metadata: {} }],
    truncated: false,
  };
  fs.writeFileSync(
    path.join(dir, "cells.jsonl"),
    JSON.stringify(cell) + "\n" + '{"v":1,"type":"cell","sour',
    "utf-8",
  );

  const ok = runExport(dir);
  assert.equal(ok.status, 0, ok.stderr);
  const notebook = JSON.parse(fs.readFileSync(path.join(dir, "out.ipynb"), "utf-8"));
  assert.equal(notebook.cells.length, 2);

  fs.writeFileSync(
    path.join(dir, "cells.jsonl"),
    JSON.stringify(cell) + "\nnot json\n",
    "utf-8",
  );
  const bad = runExport(dir, { out: "bad.ipynb" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /journal line 2: invalid JSON/);
  assert.equal(fs.existsSync(path.join(dir, "bad.ipynb")), false);

  fs.writeFileSync(path.join(dir, "cells.jsonl"), '{"v":1,"type":"cell","sour', "utf-8");
  const partial = runExport(dir, { out: "partial.ipynb" });
  assert.equal(partial.status, 1);
  assert.match(partial.stdout, /session has no recorded cells; nothing written/);
  assert.equal(fs.existsSync(path.join(dir, "partial.ipynb")), false);
});

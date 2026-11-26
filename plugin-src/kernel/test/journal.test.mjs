import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseJournal, readJournal } from "../lib/journal.js";

const META = {
  v: 1,
  kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
  language_info: { name: "python", version: "3.12.0" },
  selection: "/usr/bin/python3",
  cells: 1,
  truncated: false,
};

const CELL = {
  v: 1,
  type: "cell",
  execution_count: 1,
  source: "print('hi')",
  outputs: [
    { output_type: "stream", name: "stdout", text: "hi\n" },
    { output_type: "display_data", data: { "image/png": "iVBORw0KGgo=" }, metadata: {} },
  ],
  truncated: false,
};

const BOUNDARY = { v: 1, type: "boundary", text: "Kernel reset" };

async function tempPaths() {
  const base = await mkdtemp(path.join(os.tmpdir(), "kernel-journal-"));
  const dir = path.join(base, "ses_test");
  return {
    dir,
    imagesDir: path.join(dir, "images"),
    logsDir: path.join(dir, "logs"),
    journal: path.join(dir, "cells.jsonl"),
    meta: path.join(dir, "meta.json"),
  };
}

test("reads meta plus cell and boundary records as written", async () => {
  const paths = await tempPaths();
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.meta, `${JSON.stringify(META)}\n`);
  await writeFile(
    paths.journal,
    `${JSON.stringify(CELL)}\n${JSON.stringify(BOUNDARY)}\n`,
  );

  const { meta, cells } = await readJournal(paths);

  assert.deepEqual(meta, META);
  assert.deepEqual(cells, [CELL, BOUNDARY]);
  // base64 image payloads pass through untransformed
  assert.equal(cells[0].outputs[1].data["image/png"], "iVBORw0KGgo=");
});

test("ignores a final unterminated line", async () => {
  const paths = await tempPaths();
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.meta, `${JSON.stringify(META)}\n`);
  await writeFile(
    paths.journal,
    `${JSON.stringify(CELL)}\n${JSON.stringify(BOUNDARY)}\n{"v":1,"type":"ce`,
  );

  const { cells } = await readJournal(paths);

  assert.deepEqual(cells, [CELL, BOUNDARY]);
});

test("fails a malformed complete line", async () => {
  const paths = await tempPaths();
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.journal,
    `${JSON.stringify(CELL)}\n{not json}\n`,
  );

  await assert.rejects(readJournal(paths), /JSON/);
});

test("skips blank lines and unknown record types", async () => {
  const paths = await tempPaths();
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.journal,
    `\n${JSON.stringify(CELL)}\n\n${JSON.stringify({ v: 1, type: "noise" })}\n`,
  );

  const { meta, cells } = await readJournal(paths);

  assert.equal(meta, null);
  assert.deepEqual(cells, [CELL]);
});

test("missing journal and meta return empties without throwing", async () => {
  const paths = await tempPaths();

  const { meta, cells } = await readJournal(paths);

  assert.equal(meta, null);
  assert.deepEqual(cells, []);
});

test("meta without a journal returns the meta and no cells", async () => {
  const paths = await tempPaths();
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.meta, JSON.stringify(META));

  const { meta, cells } = await readJournal(paths);

  assert.deepEqual(meta, META);
  assert.deepEqual(cells, []);
});

test("parseJournal keeps journal order", () => {
  const text = `${JSON.stringify(BOUNDARY)}\n${JSON.stringify(CELL)}\n`;
  assert.deepEqual(parseJournal(text), [BOUNDARY, CELL]);
});

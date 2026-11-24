import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildContent, formatResult, plainText, stripAnsi, stripHtml } from "../lib/format.js";

async function workdir() {
  const base = await mkdtemp(path.join(os.tmpdir(), "kernel-format-"));
  return {
    base,
    imagesDir: path.join(base, "images"),
    logsDir: path.join(base, "logs"),
  };
}

test("preserves stream/result order and strips ANSI escapes", async () => {
  const { imagesDir, logsDir } = await workdir();
  const out = await formatResult(
    [
      { op: "stream", id: "a", name: "stdout", text: "first\n" },
      { op: "stream", id: "a", name: "stderr", text: "\u001b[31msecond\u001b[0m\n" },
      { op: "result", id: "a", executionCount: 1, data: { "text/plain": "42" } },
      { op: "done", id: "a", status: "ok", executionCount: 1 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.text, "first\nsecond\nOut[1]: 42\n");
  assert.equal(out.executionCount, 1);
  assert.equal(out.status, "ok");
  assert.equal(out.truncated, false);
  assert.equal(out.logPath, null);
  assert.deepEqual(out.images, []);
});

test("execute_result falls back from text/plain to markdown to html", async () => {
  const { imagesDir, logsDir } = await workdir();
  const options = { imagesDir, logsDir };

  const markdown = await formatResult(
    [{ op: "result", id: "a", executionCount: 2, data: { "text/markdown": "**bold**" } }],
    options,
  );
  assert.equal(markdown.text, "Out[2]: **bold**\n");

  const html = await formatResult(
    [{ op: "result", id: "a", executionCount: 3, data: { "text/html": "<b>bold</b>" } }],
    options,
  );
  assert.equal(html.text, "Out[3]: bold\n");
});

test("display_data saves images and lists absolute paths", async () => {
  const { imagesDir, logsDir } = await workdir();
  const payload = Buffer.from("png-bytes");
  const out = await formatResult(
    [
      {
        op: "display",
        id: "a",
        data: {
          "text/plain": "<Figure size 640x480>",
          "image/png": payload.toString("base64"),
        },
      },
      { op: "done", id: "a", status: "ok", executionCount: 5 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.images.length, 1);
  assert.equal(out.images[0], path.join(imagesDir, "5-1.png"));
  assert.equal(out.text, `<Figure size 640x480>\nimage: ${out.images[0]}\n`);
  assert.deepEqual(await readFile(out.images[0]), payload);
});

test("error events format ename, evalue, and traceback", async () => {
  const { imagesDir, logsDir } = await workdir();
  const out = await formatResult(
    [
      {
        op: "error",
        id: "a",
        ename: "ValueError",
        evalue: "bad value",
        traceback: ["\u001b[31mline one\u001b[0m", "line two"],
      },
      { op: "done", id: "a", status: "error", executionCount: 4 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.text, "ValueError: bad value\nline one\nline two\n");
  assert.equal(out.status, "error");
  assert.equal(out.executionCount, 4);
});

test("an empty cell reports (no output)", async () => {
  const { imagesDir, logsDir } = await workdir();
  const out = await formatResult([{ op: "done", id: "a", status: "ok", executionCount: 0 }], {
    imagesDir,
    logsDir,
  });
  assert.equal(out.text, "(no output)");
});

test("large output is capped with head, tail, and a full log file", async () => {
  const { imagesDir, logsDir } = await workdir();
  const body = "x".repeat(60000);
  const out = await formatResult(
    [
      { op: "stream", id: "a", name: "stdout", text: body },
      { op: "done", id: "a", status: "ok", executionCount: 7 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.truncated, true);
  assert.equal(out.logPath, path.join(logsDir, "cell-7.log"));
  assert.equal(await readFile(out.logPath, "utf8"), body);
  assert.ok(out.text.startsWith("x".repeat(100)));
  assert.ok(out.text.includes("... [output elided] ..."));
  assert.ok(
    out.text.endsWith(`[truncated at 51200 bytes; full log: ${out.logPath}]`),
    out.text.slice(-120),
  );
});

test("clear_output wait:false drops prior output", async () => {
  const { imagesDir, logsDir } = await workdir();
  const out = await formatResult(
    [
      { op: "stream", id: "a", name: "stdout", text: "before\n" },
      { op: "clear_output", id: "a", wait: false },
      { op: "stream", id: "a", name: "stdout", text: "after\n" },
      { op: "done", id: "a", status: "ok", executionCount: 1 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.text, "after\n");
});

test("clear_output wait:true clears at the next output", async () => {
  const { imagesDir, logsDir } = await workdir();
  const options = { imagesDir, logsDir };

  const deferred = await formatResult(
    [
      { op: "stream", id: "a", name: "stdout", text: "before\n" },
      { op: "clear_output", id: "a", wait: true },
      { op: "stream", id: "a", name: "stdout", text: "after\n" },
      { op: "done", id: "a", status: "ok", executionCount: 1 },
    ],
    options,
  );
  assert.equal(deferred.text, "after\n");

  const untouched = await formatResult(
    [
      { op: "stream", id: "a", name: "stdout", text: "before\n" },
      { op: "clear_output", id: "a", wait: true },
      { op: "done", id: "a", status: "ok", executionCount: 1 },
    ],
    options,
  );
  assert.equal(untouched.text, "before\n");
});

test("update_display by display_id replaces the earlier data and image", async () => {
  const { imagesDir, logsDir } = await workdir();
  const firstImage = Buffer.from("first-png");
  const secondImage = Buffer.from("second-png");

  const out = await formatResult(
    [
      {
        op: "display",
        id: "a",
        data: { "text/plain": "v1", "image/png": firstImage.toString("base64") },
        transient: { display_id: "d1" },
      },
      {
        op: "update_display",
        id: "a",
        data: { "text/plain": "v2", "image/png": secondImage.toString("base64") },
        transient: { display_id: "d1" },
      },
      { op: "done", id: "a", status: "ok", executionCount: 5 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.images.length, 1);
  assert.equal(out.images[0], path.join(imagesDir, "5-2.png"));
  assert.equal(out.text, `v2\nimage: ${out.images[0]}\n`);
  assert.equal(out.imageParts.length, 1);
  assert.equal(out.imageParts[0].base64, secondImage.toString("base64"));
  const content = buildContent(out.text, out.imageParts);
  assert.equal(content.length, 2);
  assert.equal(content[1].uri, `data:image/png;base64,${secondImage.toString("base64")}`);
  assert.deepEqual(await readFile(out.images[0]), secondImage);
});

test("update_display drops the superseded display's image from the list", async () => {
  const { imagesDir, logsDir } = await workdir();
  const superseded = Buffer.from("superseded-png");
  const other = Buffer.from("other-png");
  const replacement = Buffer.from("replacement-png");

  const out = await formatResult(
    [
      {
        op: "display",
        id: "a",
        data: { "text/plain": "v1", "image/png": superseded.toString("base64") },
        transient: { display_id: "d1" },
      },
      {
        op: "display",
        id: "a",
        data: { "text/plain": "other", "image/png": other.toString("base64") },
        transient: { display_id: "d2" },
      },
      {
        op: "update_display",
        id: "a",
        data: { "text/plain": "v2", "image/png": replacement.toString("base64") },
        transient: { display_id: "d1" },
      },
      { op: "done", id: "a", status: "ok", executionCount: 6 },
    ],
    { imagesDir, logsDir },
  );

  const supersededFile = path.join(imagesDir, "6-1.png");
  const replacementFile = path.join(imagesDir, "6-3.png");
  assert.equal(out.images.length, 2);
  assert.ok(out.images.includes(replacementFile), out.images.join(","));
  assert.ok(!out.images.includes(supersededFile), out.images.join(","));
  assert.ok(out.text.includes(`image: ${replacementFile}`), out.text);
  assert.ok(!out.text.includes("image: " + supersededFile), out.text);
  assert.deepEqual(await readFile(replacementFile), replacement);
  await assert.rejects(readFile(supersededFile), /ENOENT/);
});

test("update_display without a prior display appends the new output", async () => {
  const { imagesDir, logsDir } = await workdir();
  const out = await formatResult(
    [
      {
        op: "update_display",
        id: "a",
        data: { "text/plain": "fresh" },
        transient: { display_id: "d2" },
      },
      { op: "done", id: "a", status: "ok", executionCount: 2 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.text, "fresh\n");
});

test("stripAnsi, stripHtml, and plainText helpers decode output data", () => {
  assert.equal(stripAnsi("\u001b[1mhi\u001b[0m"), "hi");
  assert.equal(stripHtml("<b>a</b>&amp;b"), "a&b");
  assert.equal(plainText({ "text/html": "<i>x</i>" }), "x");
  assert.equal(plainText({ "text/plain": "" }), "");
});

test("a small png becomes a text part plus one file part", async () => {
  const { imagesDir, logsDir } = await workdir();
  const payload = Buffer.from("png-bytes");
  const out = await formatResult(
    [
      {
        op: "display",
        id: "a",
        data: { "text/plain": "<Figure>", "image/png": payload.toString("base64") },
      },
      { op: "done", id: "a", status: "ok", executionCount: 5 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.text, `<Figure>\nimage: ${out.images[0]}\n`);
  const content = buildContent(out.text, out.imageParts);
  assert.deepEqual(content, [
    { type: "text", text: out.text },
    {
      type: "file",
      uri: `data:image/png;base64,${payload.toString("base64")}`,
      mime: "image/png",
      name: "5-1.png",
    },
  ]);
});

test("a jpeg is inlined with its own mime and jpg name", async () => {
  const { imagesDir, logsDir } = await workdir();
  const payload = Buffer.from("jpeg-bytes");
  const out = await formatResult(
    [
      { op: "display", id: "a", data: { "image/jpeg": payload.toString("base64") } },
      { op: "done", id: "a", status: "ok", executionCount: 2 },
    ],
    { imagesDir, logsDir },
  );

  const content = buildContent(out.text, out.imageParts);
  assert.equal(content.length, 2);
  assert.deepEqual(content[1], {
    type: "file",
    uri: `data:image/jpeg;base64,${payload.toString("base64")}`,
    mime: "image/jpeg",
    name: "2-1.jpg",
  });
});

test("four images inline three parts and keep all four path lines", async () => {
  const { imagesDir, logsDir } = await workdir();
  const payloads = [Buffer.from("one"), Buffer.from("two"), Buffer.from("three"), Buffer.from("four")];
  const events = payloads.map((payload, index) => ({
    op: "display",
    id: "a",
    data: {
      "text/plain": `fig${index + 1}`,
      "image/png": payload.toString("base64"),
    },
  }));
  events.push({ op: "done", id: "a", status: "ok", executionCount: 1 });

  const out = await formatResult(events, { imagesDir, logsDir });

  assert.equal(out.images.length, 4);
  for (const file of out.images) {
    assert.ok(out.text.includes(`image: ${file}`), out.text);
  }
  const content = buildContent(out.text, out.imageParts);
  assert.equal(content.length, 4);
  assert.deepEqual(
    content.slice(1).map((part) => part.name),
    ["1-1.png", "1-2.png", "1-3.png"],
  );
  assert.equal(content[0].text, out.text);
});

test("an image over 2 MiB stays a path line and gets no file part", async () => {
  const { imagesDir, logsDir } = await workdir();
  const payload = Buffer.alloc(2 * 1024 * 1024 + 1, 7);
  const out = await formatResult(
    [
      { op: "display", id: "a", data: { "image/png": payload.toString("base64") } },
      { op: "done", id: "a", status: "ok", executionCount: 3 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.images.length, 1);
  assert.deepEqual(out.imageParts, []);
  const content = buildContent(out.text, out.imageParts);
  assert.equal(content, out.text);
  assert.ok(out.text.includes(`image: ${out.images[0]}`), out.text);
});

test("an svg stays a path line and gets no file part", async () => {
  const { imagesDir, logsDir } = await workdir();
  const payload = Buffer.from("<svg></svg>");
  const out = await formatResult(
    [
      { op: "display", id: "a", data: { "image/svg+xml": payload.toString("base64") } },
      { op: "done", id: "a", status: "ok", executionCount: 4 },
    ],
    { imagesDir, logsDir },
  );

  assert.equal(out.images[0], path.join(imagesDir, "4-1.svg"));
  assert.deepEqual(out.imageParts, []);
  assert.equal(buildContent(out.text, out.imageParts), out.text);
});

test("a result without images keeps the plain text content", async () => {
  const { imagesDir, logsDir } = await workdir();
  const out = await formatResult(
    [
      { op: "stream", id: "a", name: "stdout", text: "hello\n" },
      { op: "done", id: "a", status: "ok", executionCount: 1 },
    ],
    { imagesDir, logsDir },
  );

  assert.deepEqual(out.imageParts, []);
  assert.equal(buildContent(out.text, out.imageParts), "hello\n");
  assert.equal(buildContent("plain", undefined), "plain");
});

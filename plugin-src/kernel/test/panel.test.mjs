// Tests for the /kernel TUI panel helpers.

import assert from "node:assert/strict";
import test from "node:test";

import { cellLabel, mergeCell, outputParts, panelHeader } from "../lib/panel.js";

function cell(overrides = {}) {
  return {
    v: 1,
    type: "cell",
    execution_count: 1,
    source: "1 + 1",
    outputs: [],
    truncated: false,
    ...overrides,
  };
}

test("mergeCell appends a new record", () => {
  const first = cell();
  const merged = mergeCell([first], cell({ execution_count: 2 }));
  assert.equal(merged.length, 2);
  assert.equal(merged[1].execution_count, 2);
});

test("mergeCell dedupes an identical tail record", () => {
  const first = cell();
  const cells = [first];
  const merged = mergeCell(cells, structuredClone(first));
  assert.equal(merged, cells);
  assert.equal(merged.length, 1);
});

test("mergeCell appends a record identical to a non-tail record", () => {
  const first = cell();
  const second = cell({ execution_count: 2 });
  const merged = mergeCell([first, second], structuredClone(first));
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[2], first);
});

test("mergeCell tolerates missing input and non-object records", () => {
  assert.deepEqual(mergeCell(undefined, cell()), [cell()]);
  const cells = [cell()];
  assert.equal(mergeCell(cells, null), cells);
  assert.equal(mergeCell(cells, "cell"), cells);
});

test("outputParts preserves stream newlines", () => {
  const parts = outputParts(
    cell({ outputs: [{ output_type: "stream", name: "stdout", text: "a\nb\n" }] }),
  );
  assert.deepEqual(parts, [{ kind: "text", text: "a\nb\n" }]);
});

test("outputParts prefers text/markdown and ignores text/html", () => {
  const parts = outputParts(
    cell({
      outputs: [
        {
          output_type: "display_data",
          data: {
            "text/html": "<b>ignored</b>",
            "text/markdown": "**bold**",
            "text/plain": "plain",
          },
        },
      ],
    }),
  );
  assert.deepEqual(parts, [{ kind: "markdown", text: "**bold**" }]);
});

test("outputParts falls back to text/plain", () => {
  const parts = outputParts(
    cell({
      outputs: [
        {
          output_type: "execute_result",
          execution_count: 1,
          data: { "text/plain": "42" },
        },
      ],
    }),
  );
  assert.deepEqual(parts, [{ kind: "text", text: "42" }]);
});

test("outputParts renders png and jpeg as data URIs", () => {
  const parts = outputParts(
    cell({
      outputs: [
        {
          output_type: "display_data",
          data: { "image/png": "cG5n", "image/jpeg": "anBn" },
        },
      ],
    }),
  );
  assert.deepEqual(parts, [
    { kind: "image", mime: "image/png", dataUri: "data:image/png;base64,cG5n" },
    { kind: "image", mime: "image/jpeg", dataUri: "data:image/jpeg;base64,anBn" },
  ]);
});

test("outputParts keeps an intact image when only the text was truncated", () => {
  const outputs = [
    { output_type: "display_data", data: { "image/png": "cG5n" } },
  ];
  assert.deepEqual(outputParts(cell({ truncated: true, outputs })), [
    { kind: "image", mime: "image/png", dataUri: "data:image/png;base64,cG5n" },
  ]);
});

test("outputParts renders the truncated-image placeholder for a non-base64 payload", () => {
  assert.deepEqual(
    outputParts(
      cell({
        outputs: [
          {
            output_type: "display_data",
            data: { "image/png": "[truncated image data]" },
          },
        ],
      }),
    ),
    [{ kind: "text", text: "[truncated image data]", muted: true }],
  );
  assert.deepEqual(
    outputParts(
      cell({
        outputs: [{ output_type: "display_data", data: { "image/png": "not base64!" } }],
      }),
    ),
    [{ kind: "text", text: "[truncated image data]", muted: true }],
  );
});

test("outputParts caps images at three and reports the rest", () => {
  const data = {};
  for (let i = 0; i < 4; i += 1) data["image/png"] = `aW1n${i}`;
  const outputs = [
    { output_type: "display_data", data: { "image/png": "YQ==" } },
    { output_type: "display_data", data: { "image/png": "Yg==" } },
    { output_type: "display_data", data: { "image/png": "Yw==" } },
    { output_type: "display_data", data: { "image/png": "ZA==" } },
  ];
  const parts = outputParts(cell({ outputs }));
  assert.equal(parts.filter((part) => part.kind === "image").length, 3);
  assert.deepEqual(parts[3], { kind: "text", text: "+1 more image", muted: true });
});

test("outputParts reports an error with its traceback", () => {
  const parts = outputParts(
    cell({
      outputs: [
        {
          output_type: "error",
          ename: "ValueError",
          evalue: "bad value",
          traceback: ["line one", "line two"],
        },
      ],
    }),
  );
  assert.deepEqual(parts, [
    {
      kind: "error",
      ename: "ValueError",
      evalue: "bad value",
      traceback: ["line one", "line two"],
    },
  ]);
});

test("outputParts strips ANSI escapes from streams and errors", () => {
  const parts = outputParts(
    cell({
      outputs: [
        { output_type: "stream", name: "stderr", text: "\u001b[31mred\u001b[0m\n" },
        {
          output_type: "error",
          ename: "\u001b[1mValueError\u001b[0m",
          evalue: "\u001b[31mbad\u001b[0m",
          traceback: ["\u001b[31mline\u001b[0m"],
        },
      ],
    }),
  );
  assert.deepEqual(parts, [
    { kind: "text", text: "red\n" },
    {
      kind: "error",
      ename: "ValueError",
      evalue: "bad",
      traceback: ["line"],
    },
  ]);
});

test("outputParts renders a boundary record as a divider", () => {
  const parts = outputParts({ v: 1, type: "boundary", text: "Kernel reset" });
  assert.deepEqual(parts, [{ kind: "boundary", text: "Kernel reset" }]);
  assert.deepEqual(outputParts({ v: 1, type: "boundary", text: "" }), [
    { kind: "boundary", text: "Kernel reset" },
  ]);
});

test("outputParts ignores malformed records and unknown output types", () => {
  assert.deepEqual(outputParts(null), []);
  assert.deepEqual(outputParts(cell({ outputs: "nope" })), []);
  assert.deepEqual(
    outputParts(
      cell({
        outputs: [
          null,
          { output_type: "stream", text: "" },
          { output_type: "clear_output" },
          "text",
        ],
      }),
    ),
    [],
  );
});

test("cellLabel uses the execution count and the truncated marker", () => {
  assert.equal(cellLabel(cell({ execution_count: 7 }), 0), "In[7]");
  assert.equal(
    cellLabel(cell({ execution_count: 7, truncated: true }), 0),
    "In[7] (truncated)",
  );
  assert.equal(cellLabel({ type: "boundary", text: "Kernel reset" }, 3), "--- Kernel reset ---");
  assert.equal(cellLabel({ type: "boundary", text: "Restarted" }, 3), "--- Restarted ---");
});

test("cellLabel falls back to the visible position", () => {
  assert.equal(cellLabel(cell({ execution_count: "x" }), 4), "In[5]");
  assert.equal(cellLabel(cell({ execution_count: undefined }), undefined), "In[1]");
  assert.equal(cellLabel(null, 0), "In[?]");
});

test("panelHeader defaults the selection and language", () => {
  assert.equal(panelHeader(null, []), "Kernel - default - python - 0 cells");
  assert.equal(
    panelHeader({ language_info: { name: "" }, selection: "" }, []),
    "Kernel - default - python - 0 cells",
  );
});

test("panelHeader uses the meta selection, language, and cell total", () => {
  assert.equal(
    panelHeader(
      { selection: "analysis", language_info: { name: "julia" }, cells: 12 },
      [],
    ),
    "Kernel - analysis - julia - 12 cells",
  );
});

test("panelHeader counts non-boundary cells when meta has no total", () => {
  const cells = [
    { type: "cell", execution_count: 1 },
    { type: "boundary", text: "Kernel reset" },
    { type: "cell", execution_count: 2 },
  ];
  assert.equal(panelHeader({}, cells), "Kernel - default - python - 2 cells");
  assert.equal(
    panelHeader({ cells: 1 }, cells),
    "Kernel - default - python - 1 cell",
  );
});

test("panelHeader adds the truncated suffix only for a capped snapshot", () => {
  assert.equal(panelHeader({ cells: 3, truncated: true }, []), "Kernel - default - python - 3 cells (truncated)");
  assert.equal(panelHeader({ cells: 1, truncated: true }, []), "Kernel - default - python - 1 cell (truncated)");
  assert.equal(panelHeader({ cells: 3, truncated: false }, []), "Kernel - default - python - 3 cells");
});

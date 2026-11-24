// fusion-bootstrap tier table tests.
//
// An empty tier model means the tier is unavailable in this profile, not that
// the file is invalid: the row stays in the table, renders as "unavailable",
// and the primary is told not to route that modality to any model. A tier an
// agent maps to must still carry a real model ref.
//
// Run: node --test plugin-src/fusion-bootstrap/test/

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatTierTable, loadTierTable } from "../index.js";

const TMP_BASE = existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();

const roots = [];
after(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

const TIERS = {
  tiers: {
    big: { model: "test-provider/big-model#max", description: "hard reasoning" },
    medium: { model: "test-provider/medium-model", description: "default work" },
    vision: { model: "", description: "image inspection" },
  },
  agents: {
    orchestrator: "big",
    sidekick: "medium",
  },
};

function makeConfigDir(tiers) {
  const root = mkdtempSync(path.join(TMP_BASE, "bootstrap-tiers-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "profiles", "demo"), { recursive: true });
  writeFileSync(
    path.join(root, "profiles", "demo", "tiers.json"),
    JSON.stringify(tiers, null, 2) + "\n",
  );
  return root;
}

test("loadTierTable keeps an empty-model tier and includes it in the table", () => {
  const configDir = makeConfigDir(structuredClone(TIERS));
  const table = loadTierTable(configDir, "demo");
  assert.ok(table, "table loads");
  const vision = table.entries.find((entry) => entry.name === "vision");
  assert.deepEqual(vision, { name: "vision", model: "", description: "image inspection" });
  assert.equal(table.mapping.sidekick, "medium");
});

test("formatTierTable renders an empty model as unavailable and warns the primary", () => {
  const configDir = makeConfigDir(structuredClone(TIERS));
  const text = formatTierTable(loadTierTable(configDir, "demo"));
  assert.match(text, /^- vision: unavailable - image inspection$/m);
  assert.match(
    text,
    /A tier marked unavailable has no model in this profile; do not route work that needs it to any model, and tell the user it is unavailable\./,
  );
});

test("formatTierTable omits the unavailable sentence when every tier has a model", () => {
  const data = structuredClone(TIERS);
  data.tiers.vision.model = "test-provider/vision-model";
  const configDir = makeConfigDir(data);
  const text = formatTierTable(loadTierTable(configDir, "demo"));
  assert.match(text, /^- vision: test-provider\/vision-model - image inspection$/m);
  assert.doesNotMatch(text, /marked unavailable/);
});

test("loadTierTable rejects an empty model on a mapped tier", () => {
  const data = structuredClone(TIERS);
  data.agents.sidekick = "vision";
  const configDir = makeConfigDir(data);
  assert.equal(loadTierTable(configDir, "demo"), null);
});

test("loadTierTable still rejects a missing or non-string model", () => {
  for (const model of [undefined, null, 42]) {
    const data = structuredClone(TIERS);
    if (model === undefined) delete data.tiers.vision.model;
    else data.tiers.vision.model = model;
    const configDir = makeConfigDir(data);
    assert.equal(loadTierTable(configDir, "demo"), null, String(model));
  }
});

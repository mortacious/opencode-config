// repo tooling tests: scripts/tiers-sync.mjs (profile model tiers -> overlays).
//
// These live under the repo scripts/ test directory because `npm test` runs
// `node --test scripts/test/`; the module under test is the repo-level tier
// expander, not a plugin module.
//
// Coverage:
//   1. expansion output shape (GENERATED header, $schema, agent pins,
//      small_model) and idempotent re-sync
//   2. --check exits 0 on a synced tree and 1 with named drifts after an edit
//   3. invalid tiers.json is rejected (missing tier, bad ref, unknown agent)
//   4. retargeting every tier re-pins every agent (the --swap-model tiers
//      rewrite + resync; bin/oc performs the JSON edit itself with jq)
//
// Run: node --test scripts/test/

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_HEADER } from "../../scripts/tiers-sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const TOOL = path.join(REPO_ROOT, "scripts", "tiers-sync.mjs");
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

const AGENT_FILES = ["orchestrator", "sidekick", "analyst", "reviewer"];

const TIERS = {
  tiers: {
    big: { model: "test-provider/big-model#max", description: "hard reasoning" },
    medium: { model: "test-provider/medium-model", description: "default work" },
    small: { model: "test-provider/small-model", description: "mechanical edits" },
    vision: { model: "test-provider/vision-model", description: "image inspection" },
  },
  agents: {
    orchestrator: "big",
    sidekick: "medium",
    analyst: "medium",
    reviewer: "medium",
    title: "small",
  },
};

function makeRoot() {
  const root = mkdtempSync(path.join(TMP_BASE, "tiers-sync-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "agents"), { recursive: true });
  mkdirSync(path.join(root, "profiles", "demo"), { recursive: true });
  for (const name of AGENT_FILES) {
    writeFileSync(path.join(root, "agents", `${name}.md`), "---\nmode: subagent\n---\n");
  }
  writeTiers(root, "demo", TIERS);
  return root;
}

function writeTiers(root, profile, data) {
  writeFileSync(
    path.join(root, "profiles", profile, "tiers.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function overlayPath(root, profile = "demo") {
  return path.join(root, "profiles", profile, "opencode.jsonc");
}

function run(root, args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    env: { ...process.env, TIERS_SYNC_ROOT: root },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readOverlay(root, profile = "demo") {
  const text = readFileSync(overlayPath(root, profile), "utf8");
  return { text, config: JSON.parse(text.replace(/^\/\/[^\n]*\n/, "")) };
}

test("expansion writes the generated overlay shape and re-sync is a no-op", () => {
  const root = makeRoot();
  const first = run(root, ["--profile", "demo"]);
  assert.equal(first.status, 0, first.stderr);
  const { text, config } = readOverlay(root);
  assert.ok(text.startsWith(GENERATED_HEADER + "\n"), "GENERATED header is the first line");
  assert.ok(text.endsWith("\n"), "overlay ends with a trailing newline");
  assert.deepEqual(config, {
    $schema: "https://opencode.ai/config.json",
    agents: {
      orchestrator: { model: "test-provider/big-model#max" },
      sidekick: { model: "test-provider/medium-model" },
      analyst: { model: "test-provider/medium-model" },
      reviewer: { model: "test-provider/medium-model" },
      title: { model: "test-provider/small-model" },
    },
    small_model: "test-provider/small-model",
  });
  assert.match(text, /^ {2}"agents": \{$/m);
  assert.match(text, /^ {4}"orchestrator": \{ "model": "test-provider\/big-model#max" \},$/m);

  const second = run(root, ["--profile", "demo"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /up to date/);
  assert.equal(readOverlay(root).text, text, "second sync leaves the file byte-identical");
});

test("--check passes when synced and fails with named drifts after an edit", () => {
  const root = makeRoot();
  assert.equal(run(root, ["--all"]).status, 0);
  const clean = run(root, ["--check", "--all"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /1 profile\(s\) checked, 0 drift\(s\)/);

  const { config } = readOverlay(root);
  config.agents.reviewer.model = "test-provider/big-model#max";
  config.small_model = "test-provider/big-model#max";
  writeFileSync(overlayPath(root), JSON.stringify(config, null, 2) + "\n");

  const drifted = run(root, ["--check", "--profile", "demo"]);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /DRIFT profiles\/demo\/opencode\.jsonc: agents\.reviewer\.model is/);
  assert.match(drifted.stderr, /small_model is/);
  assert.match(drifted.stdout, /1 profile\(s\) checked, 2 drift\(s\)/);
});

test("invalid tiers.json is rejected with an actionable error", () => {
  const cases = [
    [
      "missing description",
      (data) => {
        delete data.tiers.small.description;
        return data;
      },
      /tier "small" description must be a non-empty string/,
    ],
    [
      "bad ref",
      (data) => {
        data.tiers.vision.model = "no-slash";
        return data;
      },
      /tier "vision" model "no-slash" is not <provider>\/<model>\[#variant\]/,
    ],
    [
      "unknown agent",
      (data) => {
        data.agents.ghost = "big";
        return data;
      },
      /agents\.ghost has no agents\/ghost\.md and is not a built-in/,
    ],
    [
      "unknown tier value",
      (data) => {
        data.agents.orchestrator = "huge";
        return data;
      },
      /agents\.orchestrator must name an existing tier \(got "huge"\)/,
    ],
  ];
  for (const [label, mutate, pattern] of cases) {
    const root = makeRoot();
    writeTiers(root, "demo", mutate(structuredClone(TIERS)));
    const result = run(root, ["--profile", "demo"]);
    assert.equal(result.status, 1, `${label}: expected exit 1`);
    assert.match(result.stderr, pattern, label);
    assert.equal(existsSync(overlayPath(root)), false, `${label}: no overlay written`);
  }
});

test("retargeting every tier re-pins every agent (swap-model tiers path)", () => {
  const root = makeRoot();
  assert.equal(run(root, ["--profile", "demo"]).status, 0);
  const data = structuredClone(TIERS);
  for (const key of Object.keys(data.tiers)) {
    data.tiers[key].model = "next/provider-model#max";
  }
  writeTiers(root, "demo", data);
  const synced = run(root, ["--profile", "demo"]);
  assert.equal(synced.status, 0, synced.stderr);
  const { config } = readOverlay(root);
  for (const name of Object.keys(TIERS.agents)) {
    assert.equal(config.agents[name].model, "next/provider-model#max", name);
  }
  assert.equal(config.small_model, "next/provider-model#max");
});

test("custom tier names are profile data: expansion uses the file's own names", () => {
  const root = makeRoot();
  const data = {
    tiers: {
      deep: { model: "test-provider/deep-model#max", description: "deep reasoning" },
      quick: { model: "test-provider/quick-model", description: "quick edits" },
    },
    agents: { orchestrator: "deep", sidekick: "quick", title: "quick" },
  };
  writeTiers(root, "demo", data);
  const result = run(root, ["--profile", "demo"]);
  assert.equal(result.status, 0, result.stderr);
  const { config } = readOverlay(root);
  assert.equal(config.agents.orchestrator.model, "test-provider/deep-model#max");
  assert.equal(config.agents.sidekick.model, "test-provider/quick-model");
  assert.equal(config.small_model, "test-provider/quick-model");
});

test("an empty model is allowed on an unmapped tier and does not reach the overlay", () => {
  const root = makeRoot();
  const data = structuredClone(TIERS);
  data.tiers.vision.model = "";
  writeTiers(root, "demo", data);
  const synced = run(root, ["--profile", "demo"]);
  assert.equal(synced.status, 0, synced.stderr);
  const { config } = readOverlay(root);
  assert.equal(Object.prototype.hasOwnProperty.call(config.agents, "vision"), false);
  assert.equal(config.agents.orchestrator.model, "test-provider/big-model#max");
  const checked = run(root, ["--check", "--profile", "demo"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /0 drift\(s\)/);
});

test("an empty model on a mapped tier is rejected", () => {
  const root = makeRoot();
  const data = structuredClone(TIERS);
  data.tiers.small.model = "";
  writeTiers(root, "demo", data);
  const result = run(root, ["--profile", "demo"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /tier "small" model is empty but agents map to it; a mapped tier needs <provider>\/<model>\[#variant\]/,
  );
  assert.equal(existsSync(overlayPath(root)), false, "no overlay written");
});

// fusion-bootstrap tier-injection tests (fake-ctx harness).
//
// Coverage:
//   1. an active profile with tiers.json -> the PRIMARY part carries the
//      tier table; a child session gets the SKILLS contract and no table
//   2. missing tiers.json -> primary reminder only, no table
//   3. invalid tiers.json -> no throw, no table
//   4. profile resolution falls back to the global .active-profile record
//   5. the plugin setup registers a working context hook (real plugin entry)
//
// Run: node --test plugin-src/fusion-bootstrap/test/

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import plugin, { createContextHandler } from "../index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const TMP_BASE = existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();

const TIERS = {
  tiers: {
    big: "test-provider/big-model#max",
    medium: "test-provider/medium-model",
    small: "test-provider/small-model",
    vision: "test-provider/vision-model",
  },
  agents: {
    build: "big",
    plan: "big",
    sidekick: "medium",
    vision: "vision",
  },
};

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

function makeConfigDir({ tiers, activeProfile } = {}) {
  const root = mkdtempSync(path.join(TMP_BASE, "bootstrap-tiers-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "profiles", "demo"), { recursive: true });
  if (tiers !== undefined) {
    writeFileSync(
      path.join(root, "profiles", "demo", "tiers.json"),
      typeof tiers === "string" ? tiers : JSON.stringify(tiers, null, 2) + "\n",
    );
  }
  if (activeProfile !== undefined) {
    writeFileSync(path.join(root, ".active-profile"), activeProfile);
  }
  return root;
}

function demoEnv(root) {
  return { OPENCODE_CONFIG: path.join(root, "profiles", "demo", "opencode.jsonc") };
}

const SESSIONS = {
  ses_root: { parentID: undefined },
  ses_child: { parentID: "ses_root" },
};

async function getSession({ sessionID }) {
  return SESSIONS[sessionID];
}

function systemText(input) {
  assert.equal(input.system.length, 1, "exactly one bootstrap part");
  return input.system[0].text;
}

test("primary carries the active profile's tier table; child does not", async () => {
  const root = makeConfigDir({ tiers: TIERS });
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
  });

  for (const agent of ["build", "plan"]) {
    const primary = { agent, sessionID: "ses_root", system: [] };
    await handler(primary);
    const text = systemText(primary);
    assert.ok(text.startsWith("Fusion bootstrap:"), agent);
    assert.ok(text.includes('Model tiers (profile "demo"'), agent);
    assert.ok(text.includes("big: test-provider/big-model#max"), agent);
    assert.ok(text.includes("medium: test-provider/medium-model"), agent);
    assert.ok(text.includes("small: test-provider/small-model"), agent);
    assert.ok(text.includes("vision: test-provider/vision-model"), agent);
    assert.ok(
      text.includes("Agent defaults: build=big, plan=big, sidekick=medium, vision=vision"),
      agent,
    );
    assert.ok(text.includes("whole-branch final review uses big"), agent);
    assert.ok(text.includes("subagent tool's model parameter"), agent);
  }

  const child = { agent: "build", sessionID: "ses_child", system: [] };
  await handler(child);
  const childText = systemText(child);
  assert.ok(childText.includes("SKILLS:"), "child keeps the canary contract");
  assert.ok(!childText.includes("Model tiers"), "child injection has no tier table");
});

test("missing tiers.json injects the primary reminder without a tier table", async () => {
  const root = makeConfigDir();
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
  });
  const primary = { agent: "build", sessionID: "ses_root", system: [] };
  await handler(primary);
  const text = systemText(primary);
  assert.ok(text.includes("check the skill catalog"));
  assert.ok(!text.includes("Model tiers"));
});

test("invalid tiers.json does not throw and injects no tier table", async () => {
  const root = makeConfigDir({ tiers: '{ "tiers": ' });
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
  });
  const primary = { agent: "plan", sessionID: "ses_root", system: [] };
  await handler(primary);
  const text = systemText(primary);
  assert.ok(text.includes("check the skill catalog"));
  assert.ok(!text.includes("Model tiers"));
});

test("profile resolution falls back to the .active-profile global record", async () => {
  const root = makeConfigDir({ tiers: TIERS, activeProfile: "global\tdemo\n" });
  const handler = createContextHandler({ configDir: root, env: {}, getSession });
  const primary = { agent: "build", sessionID: "ses_root", system: [] };
  await handler(primary);
  assert.ok(systemText(primary).includes('Model tiers (profile "demo"'));
});

test("plugin setup registers a hook that injects the real default-profile tiers", async () => {
  const savedConfig = process.env.OPENCODE_CONFIG;
  const savedLog = console.log;
  let handler;
  const ctx = {
    session: {
      get: async ({ sessionID }) => SESSIONS[sessionID],
      hook: async (name, fn) => {
        assert.equal(name, "context");
        handler = fn;
        return { dispose() {} };
      },
    },
  };
  try {
    process.env.OPENCODE_CONFIG = path.join(
      REPO_ROOT,
      "profiles",
      "default",
      "opencode.jsonc",
    );
    console.log = () => {};
    const dispose = await plugin.setup(ctx);
    assert.equal(typeof handler, "function", "setup registers the context handler");

    const primary = { agent: "build", sessionID: "ses_root", system: [] };
    await handler(primary);
    const text = systemText(primary);
    assert.ok(text.includes('Model tiers (profile "default"'));
    assert.ok(text.includes("opencode-go/gpt-5.6-luna"));

    const child = { agent: "sidekick", sessionID: "ses_child", system: [] };
    await handler(child);
    assert.ok(!systemText(child).includes("Model tiers"));

    await dispose();
  } finally {
    console.log = savedLog;
    if (savedConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = savedConfig;
  }
});

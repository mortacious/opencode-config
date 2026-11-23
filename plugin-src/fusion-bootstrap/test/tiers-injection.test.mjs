// fusion-bootstrap tier-injection tests (fake-ctx harness).
//
// Coverage:
//   1. an active profile with tiers.json -> the PRIMARY part carries the
//      tier table; a child session gets the SKILLS contract and no table
//   2. missing tiers.json -> primary reminder only, no table
//   3. invalid tiers.json -> no throw, no table
//   4. profile resolution falls back to the global .active-profile record
//   5. the plugin setup registers a working context hook (real plugin entry)
//   6. the permission brief: sidekick (edit allow, shell allow-with-denies),
//      reviewer (shell deny-by-default listing allowed families), primary
//      (brief plus tier table), and missing agent info (no brief, no throw)
//   7. capability detection: any agent whose info reports mode "primary" gets
//      the primary nudge (a custom name proves no roster is hardcoded), and
//      a root session whose agent mode cannot be resolved gets no nudge
//
// Run: node --test plugin-src/fusion-bootstrap/test/

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import plugin, { createContextHandler, formatPermissionBrief } from "../index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const TMP_BASE = existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();

const TIERS = {
  tiers: {
    big: { model: "test-provider/big-model#max", description: "hard reasoning" },
    medium: {
      model: "test-provider/medium-model",
      description: "default implementation",
    },
    small: { model: "test-provider/small-model", description: "mechanical edits" },
    vision: { model: "test-provider/vision-model", description: "image inspection" },
  },
  agents: {
    orchestrator: "big",
    sidekick: "medium",
    analyst: "medium",
    reviewer: "medium",
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

// Fake agent domain: the real ctx.agent.get returns { data: Agent.Info }, where
// Info carries the merged permissions array for that agent.
const AGENTS = {
  orchestrator: {
    name: "orchestrator",
    mode: "primary",
    permissions: [
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "sidekick", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "shell", resource: "rm*", effect: "deny" },
      { action: "shell", resource: "mv*", effect: "deny" },
      { action: "shell", resource: "git commit*", effect: "allow" },
    ],
  },
  sidekick: {
    name: "sidekick",
    mode: "subagent",
    permissions: [
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "shell", resource: "git commit*", effect: "deny" },
      { action: "shell", resource: "git push*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ],
  },
  reviewer: {
    name: "reviewer",
    mode: "subagent",
    permissions: [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "websearch", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "analyst", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git*", effect: "allow" },
      { action: "shell", resource: "cat*", effect: "allow" },
      { action: "shell", resource: "git commit*", effect: "deny" },
      { action: "shell", resource: "*>*", effect: "deny" },
    ],
  },
};

async function getAgent({ agentID }) {
  const agent = AGENTS[agentID];
  return agent ? { data: agent } : undefined;
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
    getAgent,
  });

  for (const agent of ["orchestrator"]) {
    const primary = { agent, sessionID: "ses_root", system: [] };
    await handler(primary);
    const text = systemText(primary);
    assert.ok(text.startsWith("Fusion bootstrap:"), agent);
    assert.ok(text.includes('Model tiers (profile "demo"'), agent);
    assert.ok(text.includes("- big: test-provider/big-model#max - hard reasoning"), agent);
    assert.ok(
      text.includes("- medium: test-provider/medium-model - default implementation"),
      agent,
    );
    assert.ok(
      text.includes("- small: test-provider/small-model - mechanical edits"),
      agent,
    );
    assert.ok(
      text.includes("- vision: test-provider/vision-model - image inspection"),
      agent,
    );
    assert.ok(
      text.includes("Agent defaults: analyst=medium, orchestrator=big, reviewer=medium, sidekick=medium"),
      agent,
    );
    assert.ok(text.includes("choose the tier whose description matches the work"), agent);
    assert.ok(text.includes("subagent tool's model parameter"), agent);
    assert.ok(!text.includes("whole-branch final review uses big"), agent);
  }

  const child = { agent: "analyst", sessionID: "ses_child", system: [] };
  await handler(child);
  const childText = systemText(child);
  assert.ok(childText.includes("SKILLS:"), "child keeps the canary contract");
  assert.ok(!childText.includes("Model tiers"), "child injection has no tier table");
});

test("custom tier names render from the file with nothing hardcoded", async () => {
  const custom = {
    tiers: {
      deep: { model: "test-provider/deep-model#max", description: "deep reasoning" },
      quick: { model: "test-provider/quick-model", description: "quick mechanical edits" },
    },
    agents: { orchestrator: "deep", sidekick: "quick" },
  };
  const root = makeConfigDir({ tiers: custom });
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent,
  });
  const primary = { agent: "orchestrator", sessionID: "ses_root", system: [] };
  await handler(primary);
  const text = systemText(primary);
  assert.ok(text.includes("- deep: test-provider/deep-model#max - deep reasoning"));
  assert.ok(text.includes("- quick: test-provider/quick-model - quick mechanical edits"));
  assert.ok(text.includes("Agent defaults: orchestrator=deep, sidekick=quick"));
  assert.ok(
    !/(^|\n)- (big|medium|small|vision): /.test(text),
    "no hardcoded tier names leak into the block",
  );
  assert.ok(text.indexOf("- deep:") < text.indexOf("- quick:"), "file order is preserved");
});

test("a tier without a description yields no tier table (fail-soft)", async () => {
  const broken = {
    tiers: {
      big: { model: "test-provider/big-model#max", description: "hard reasoning" },
      medium: { model: "test-provider/medium-model" },
    },
    agents: { orchestrator: "big", sidekick: "medium" },
  };
  const root = makeConfigDir({ tiers: broken });
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent,
  });
  const primary = { agent: "orchestrator", sessionID: "ses_root", system: [] };
  await handler(primary);
  const text = systemText(primary);
  assert.ok(text.includes("check the skill catalog"));
  assert.ok(!text.includes("Model tiers"));
});

test("missing tiers.json injects the primary reminder without a tier table", async () => {
  const root = makeConfigDir();
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent,
  });
  const primary = { agent: "orchestrator", sessionID: "ses_root", system: [] };
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
    getAgent,
  });
  const primary = { agent: "orchestrator", sessionID: "ses_root", system: [] };
  await handler(primary);
  const text = systemText(primary);
  assert.ok(text.includes("check the skill catalog"));
  assert.ok(!text.includes("Model tiers"));
});

test("profile resolution falls back to the .active-profile global record", async () => {
  const root = makeConfigDir({ tiers: TIERS, activeProfile: "global\tdemo\n" });
  const handler = createContextHandler({ configDir: root, env: {}, getSession, getAgent });
  const primary = { agent: "orchestrator", sessionID: "ses_root", system: [] };
  await handler(primary);
  assert.ok(systemText(primary).includes('Model tiers (profile "demo"'));
});

test("a custom primary name gets the primary nudge (no hardcoded roster)", async () => {
  const custom = {
    tiers: {
      deep: { model: "test-provider/deep-model#max", description: "deep reasoning" },
      quick: { model: "test-provider/quick-model", description: "quick mechanical edits" },
    },
    agents: { lead: "deep", helper: "quick" },
  };
  const root = makeConfigDir({ tiers: custom });
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent: async ({ agentID }) =>
      agentID === "lead"
        ? {
            data: {
              name: "lead",
              mode: "primary",
              permissions: [
                { action: "read", resource: "*", effect: "allow" },
                { action: "shell", resource: "*", effect: "allow" },
                { action: "shell", resource: "git commit*", effect: "deny" },
              ],
            },
          }
        : undefined,
  });
  const primary = { agent: "lead", sessionID: "ses_root", system: [] };
  await handler(primary);
  const text = systemText(primary);
  assert.ok(text.startsWith("Fusion bootstrap:"));
  assert.ok(text.includes("check the skill catalog"));
  assert.ok(text.includes('Fusion permissions for agent "lead"'));
  assert.ok(text.includes('Model tiers (profile "demo"'));
  assert.ok(text.includes("Agent defaults: helper=quick, lead=deep"));
});

test("a root session without a resolved primary mode gets no nudge (fail-soft)", async () => {
  const root = makeConfigDir({ tiers: TIERS });
  const variants = [
    {},
    { getAgent: async () => undefined },
    { getAgent: async () => ({ data: { name: "ghost" } }) },
    {
      getAgent: async () => {
        throw new Error("agent lookup failed");
      },
    },
  ];
  for (const extra of variants) {
    const handler = createContextHandler({
      configDir: root,
      env: demoEnv(root),
      getSession,
      ...extra,
    });
    const session = { agent: "lead", sessionID: "ses_root", system: [] };
    await handler(session);
    assert.equal(session.system.length, 0, "no part without a resolved primary mode");
  }

  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent,
  });
  const subagentOnRoot = { agent: "reviewer", sessionID: "ses_root", system: [] };
  await handler(subagentOnRoot);
  assert.equal(subagentOnRoot.system.length, 0, "subagent mode is not a primary");
});

test("child receives the permission brief: sidekick edit allow, shell allow-with-denies", async () => {
  const root = makeConfigDir();
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent,
  });
  const child = { agent: "sidekick", sessionID: "ses_child", system: [] };
  await handler(child);
  const text = systemText(child);
  assert.ok(text.startsWith("Fusion bootstrap:"), "child contract stays first");
  assert.ok(text.includes("SKILLS:"), "child keeps the canary contract");
  assert.ok(text.includes('Fusion permissions for agent "sidekick"'));
  assert.ok(text.includes("- edit: allow"));
  assert.ok(text.includes("- shell: allow by default with 2 deny rules"));
  assert.ok(text.includes("- subagent: deny"));
  assert.ok(
    text.includes("Unmatched calls fall back to the profile default effect (often ask)."),
  );
  assert.ok(!text.includes("Model tiers"), "child still has no tier table");
});

test("child permission brief: reviewer is shell deny-by-default listing families", async () => {
  const root = makeConfigDir();
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent,
  });
  const child = { agent: "reviewer", sessionID: "ses_child", system: [] };
  await handler(child);
  const text = systemText(child);
  assert.ok(text.includes('Fusion permissions for agent "reviewer"'));
  assert.ok(text.includes("- edit: deny (no file writes)"));
  assert.ok(text.includes("- shell: deny by default; allowed: git, cat"));
  assert.ok(text.includes("- webfetch: deny; websearch: deny"));
  assert.ok(text.includes("- subagent: deny (allowed: analyst)"));
});

test("the permission brief stays within its 500-character target", () => {
  const brief = formatPermissionBrief("reviewer", AGENTS.reviewer.permissions);
  assert.ok(brief.length > 0);
  assert.ok(brief.length <= 500, "brief length " + brief.length);
  const sidekick = formatPermissionBrief("sidekick", AGENTS.sidekick.permissions);
  assert.ok(sidekick.length <= 500, "brief length " + sidekick.length);
});

test("primary receives the permission brief plus the tier block", async () => {
  const root = makeConfigDir({ tiers: TIERS });
  const handler = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent,
  });
  const primary = { agent: "orchestrator", sessionID: "ses_root", system: [] };
  await handler(primary);
  const text = systemText(primary);
  assert.ok(text.includes('Fusion permissions for agent "orchestrator"'));
  assert.ok(text.includes("- edit: deny (no file writes)"));
  assert.ok(text.includes("- shell: allow by default with 2 deny rules"));
  assert.ok(text.includes("- subagent: deny (allowed: sidekick)"));
  assert.ok(text.includes('Model tiers (profile "demo"'));
});

test("missing agent info injects no brief and never throws", async () => {
  const root = makeConfigDir();
  const throwing = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent: async () => {
      throw new Error("agent lookup failed");
    },
  });
  const child = { agent: "ghost", sessionID: "ses_child", system: [] };
  await throwing(child);
  assert.ok(!systemText(child).includes("Fusion permissions"));

  const undefinedInfo = createContextHandler({
    configDir: root,
    env: demoEnv(root),
    getSession,
    getAgent: async () => undefined,
  });
  const other = { agent: "ghost", sessionID: "ses_child", system: [] };
  await undefinedInfo(other);
  assert.ok(!systemText(other).includes("Fusion permissions"));

  const bare = createContextHandler({ configDir: root, env: demoEnv(root), getSession });
  const plain = { agent: "sidekick", sessionID: "ses_child", system: [] };
  await bare(plain);
  assert.ok(!systemText(plain).includes("Fusion permissions"));
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
    agent: { get: getAgent },
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

    const primary = { agent: "orchestrator", sessionID: "ses_root", system: [] };
    await handler(primary);
    const text = systemText(primary);
    assert.ok(text.includes('Model tiers (profile "default"'));
    assert.ok(text.includes("opencode-go/glm-5.3-flash"));
    assert.ok(
      text.includes(
        "- vision: opencode-go/glm-5.3-flash - image, screenshot, diagram, and visual PDF inspection",
      ),
      "the real default profile's authored description is rendered",
    );

    const child = { agent: "sidekick", sessionID: "ses_child", system: [] };
    await handler(child);
    assert.ok(!systemText(child).includes("Model tiers"));
    assert.ok(
      systemText(child).includes('Fusion permissions for agent "sidekick"'),
      "plugin wiring passes the agent domain through to the brief",
    );

    await dispose();
  } finally {
    console.log = savedLog;
    if (savedConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = savedConfig;
  }
});

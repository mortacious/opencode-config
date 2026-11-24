// subagent-cap tests: active-profile resolution through the shared resolver.
//
// The effective cap is keyed by the resolved profile: launched OPENCODE_CONFIG
// overlay > OC_PROFILE > this directory's record in .active-profile > global >
// "default". Each case builds an isolated config dir (profile overlays + state
// file) so the real CONFIG_DIR and its state file are never touched.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  blockMessage,
  detectActiveProfile,
  normalizeOptions,
  resolveEffectiveCap,
} from "../lib/cap.js";

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

const OPTS = normalizeOptions({ max: 0, profiles: { "cheap-local": 3 } });

function makeConfigDir() {
  const root = mkdtempSync(path.join(TMP_BASE, "subagent-cap-profile-test-"));
  roots.push(root);
  return root;
}

function addProfile(configDir, name) {
  const dir = path.join(configDir, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "opencode.jsonc"), "{}\n");
  return dir;
}

function makeDir(configDir, name) {
  const dir = path.join(configDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeState(configDir, lines) {
  writeFileSync(path.join(configDir, ".active-profile"), lines.join("\n") + "\n");
}

function capFor(configDir, options) {
  return resolveEffectiveCap(OPTS, detectActiveProfile({ configDir, ...options }));
}

test("plain launch: the directory's cheap-local record applies the cap", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  addProfile(configDir, "cheap-local");
  writeState(configDir, ["location\t" + dir + "\tcheap-local"]);
  assert.equal(
    detectActiveProfile({ env: {}, configDir, directory: dir }),
    "cheap-local"
  );
  assert.equal(capFor(configDir, { env: {}, directory: dir }), 3);
});

test("OC_PROFILE applies the named profile's cap", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  addProfile(configDir, "cheap-local");
  addProfile(configDir, "nightsense");
  writeState(configDir, ["location\t" + dir + "\tnightsense"]);
  assert.equal(
    detectActiveProfile({
      env: { OC_PROFILE: "cheap-local" },
      configDir,
      directory: dir,
    }),
    "cheap-local"
  );
  assert.equal(
    capFor(configDir, { env: { OC_PROFILE: "cheap-local" }, directory: dir }),
    3
  );
});

test("no record: the base max applies", () => {
  const configDir = makeConfigDir();
  assert.equal(detectActiveProfile({ env: {}, configDir }), "default");
  assert.equal(capFor(configDir, { env: {} }), 0);
  assert.equal(
    capFor(configDir, { env: {}, directory: makeDir(configDir, "work") }),
    0
  );
});

test("an unusable OC_PROFILE falls through to the directory record", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  addProfile(configDir, "cheap-local");
  writeState(configDir, ["location\t" + dir + "\tcheap-local"]);
  assert.equal(
    capFor(configDir, { env: { OC_PROFILE: "ghost" }, directory: dir }),
    3
  );
});

test("OPENCODE_CONFIG overlay wins over the record and OC_PROFILE", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  addProfile(configDir, "cheap-local");
  addProfile(configDir, "nightsense");
  writeState(configDir, ["location\t" + dir + "\tnightsense"]);
  const env = {
    OPENCODE_CONFIG: path.join(
      configDir,
      "profiles",
      "cheap-local",
      "opencode.jsonc"
    ),
    OC_PROFILE: "nightsense",
  };
  assert.equal(detectActiveProfile({ env, configDir, directory: dir }), "cheap-local");
  assert.equal(capFor(configDir, { env, directory: dir }), 3);
});

test("a resolved profile without a cap entry falls back to the base max", () => {
  const configDir = makeConfigDir();
  addProfile(configDir, "nightsense");
  writeState(configDir, ["global\tnightsense"]);
  assert.equal(capFor(configDir, { env: {} }), 0);
  const capped = normalizeOptions({ max: 2, profiles: { "cheap-local": 3 } });
  assert.equal(
    resolveEffectiveCap(capped, detectActiveProfile({ env: {}, configDir })),
    2
  );
});

test("block message carries cap, count, profile and remedy", () => {
  assert.equal(
    blockMessage(2, 3, "cheap-local"),
    'subagent cap reached: 2/3 running under profile "cheap-local" - this delegation was blocked. ' +
      "Wait for running subagents to finish, then retry (completed subagents free capacity automatically)."
  );
  assert.match(blockMessage(1, 2, undefined), /under profile "base"/);
});

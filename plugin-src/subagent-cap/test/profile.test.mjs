// subagent-cap tests: profile mapping from OPENCODE_CONFIG.
//
// detection mirrors profile-switcher: bin/oc sets
// OPENCODE_CONFIG=<CONFIG_DIR>/profiles/<name>/opencode.jsonc. The env var is
// set and restored per case.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  blockMessage,
  detectLaunchedProfile,
  normalizeOptions,
  resolveEffectiveCap,
} from "../lib/cap.js";

// <config>/plugin-src/subagent-cap/test -> <config>
const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OPTS = normalizeOptions({ max: 0, profiles: { "cheap-local": 3 } });

function withConfig(value, fn) {
  const saved = process.env.OPENCODE_CONFIG;
  try {
    if (value === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = saved;
  }
}

test("cheap-local profile resolves to cap 3", () => {
  withConfig(join(CONFIG_DIR, "profiles", "cheap-local", "opencode.jsonc"), () => {
    assert.equal(detectLaunchedProfile(), "cheap-local");
    assert.equal(resolveEffectiveCap(OPTS, detectLaunchedProfile()), 3);
  });
});

test("base config (no profile overlay) resolves to max", () => {
  withConfig(join(CONFIG_DIR, "opencode.jsonc"), () => {
    assert.equal(detectLaunchedProfile(), undefined);
    assert.equal(resolveEffectiveCap(OPTS, detectLaunchedProfile()), 0);
  });
  withConfig(undefined, () => {
    assert.equal(detectLaunchedProfile(), undefined);
    assert.equal(resolveEffectiveCap(OPTS, detectLaunchedProfile()), 0);
  });
});

test("unmapped profile falls back to max", () => {
  withConfig(join(CONFIG_DIR, "profiles", "secure", "opencode.jsonc"), () => {
    assert.equal(detectLaunchedProfile(), "secure");
    assert.equal(resolveEffectiveCap(OPTS, detectLaunchedProfile()), 0);
  });
  withConfig(join(CONFIG_DIR, "profiles", "secure", "opencode.jsonc"), () => {
    const capped = normalizeOptions({ max: 2, profiles: { "cheap-local": 3 } });
    assert.equal(resolveEffectiveCap(capped, detectLaunchedProfile()), 2);
  });
});

test("malformed OPENCODE_CONFIG paths are not treated as profiles", () => {
  withConfig(join(CONFIG_DIR, "profiles", "cheap-local", "other.jsonc"), () => {
    assert.equal(detectLaunchedProfile(), undefined);
  });
  withConfig(join(CONFIG_DIR, "profiles", "cheap-local", "nested", "opencode.jsonc"), () => {
    assert.equal(detectLaunchedProfile(), undefined);
  });
  withConfig(join(CONFIG_DIR, "profiles", "..", "..", "opencode.jsonc"), () => {
    assert.equal(detectLaunchedProfile(), undefined);
  });
});

test("block message carries cap, count, profile and remedy", () => {
  assert.equal(
    blockMessage(2, 3, "cheap-local"),
    'subagent cap reached: 2/3 running under profile "cheap-local" - this delegation was blocked. ' +
      "Wait for running subagents to finish, then retry (completed subagents free capacity automatically)."
  );
  assert.match(blockMessage(1, 2, undefined), /under profile "base"/);
});

// profile-switcher tests: active-profile resolution through the shared
// resolver.
//
// Precedence: launched OPENCODE_CONFIG overlay (transforms suppressed) >
// OC_PROFILE (only when it names a usable profile) > this directory's
// .active-profile record > global > "default". Resolution is read-only:
// OC_PROFILE is launch-only and never reaches the state file.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { profileUsable, resolveInstanceProfile } from "../active.ts";

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

function makeConfigDir() {
  const root = mkdtempSync(path.join(TMP_BASE, "profile-switcher-active-test-"));
  roots.push(root);
  return root;
}

function addProfile(configDir, name) {
  const dir = path.join(configDir, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "opencode.jsonc"), "{}\n");
}

function makeDir(configDir, name) {
  const dir = path.join(configDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeState(configDir, lines) {
  writeFileSync(path.join(configDir, ".active-profile"), lines.join("\n") + "\n");
}

function resolve(configDir, directory, env) {
  return resolveInstanceProfile({
    configDir,
    profilesDir: path.join(configDir, "profiles"),
    directory,
    env,
  });
}

test("OC_PROFILE selects the named profile over the directory record", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  addProfile(configDir, "cheap-local");
  addProfile(configDir, "nightsense");
  writeState(configDir, ["location\t" + dir + "\tnightsense"]);
  const result = resolve(configDir, dir, { OC_PROFILE: "cheap-local" });
  assert.deepEqual(result, { name: "cheap-local", launchSuppressed: false });
});

test("an invalid OC_PROFILE falls through to the directory record", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  addProfile(configDir, "nightsense");
  writeState(configDir, ["location\t" + dir + "\tnightsense"]);
  const result = resolve(configDir, dir, { OC_PROFILE: "ghost" });
  assert.deepEqual(result, { name: "nightsense", launchSuppressed: false });
});

test("the state file is not modified by resolution, even with OC_PROFILE", () => {
  const configDir = makeConfigDir();
  const text = "global\tnightsense\n";
  writeFileSync(path.join(configDir, ".active-profile"), text);
  addProfile(configDir, "cheap-local");
  assert.equal(resolve(configDir, "", { OC_PROFILE: "cheap-local" }).name, "cheap-local");
  assert.equal(readFileSync(path.join(configDir, ".active-profile"), "utf8"), text);
});

test("the directory record applies when there is no OC_PROFILE", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  addProfile(configDir, "cheap-local");
  writeState(configDir, ["global\tnightsense", "location\t" + dir + "\tcheap-local"]);
  const result = resolve(configDir, dir, {});
  assert.deepEqual(result, { name: "cheap-local", launchSuppressed: false });
});

test("OPENCODE_CONFIG suppresses transforms even when OC_PROFILE is set", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  addProfile(configDir, "cheap-local");
  writeState(configDir, ["location\t" + dir + "\tcheap-local"]);
  const result = resolve(configDir, dir, {
    OPENCODE_CONFIG: path.join(configDir, "profiles", "launched", "opencode.jsonc"),
    OC_PROFILE: "cheap-local",
  });
  assert.deepEqual(result, { name: "launched", launchSuppressed: true });
});

test("a record naming a profile without an overlay is skipped", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  writeState(configDir, ["location\t" + dir + "\tghost", "global\tcheap-local"]);
  addProfile(configDir, "cheap-local");
  const result = resolve(configDir, dir, {});
  assert.deepEqual(result, { name: "cheap-local", launchSuppressed: false });
});

test("no record resolves to default and default is always usable", () => {
  const configDir = makeConfigDir();
  assert.deepEqual(resolve(configDir, "", {}), {
    name: "default",
    launchSuppressed: false,
  });
  assert.equal(profileUsable(path.join(configDir, "profiles"), "default"), true);
  assert.equal(profileUsable(path.join(configDir, "profiles"), "cheap-local"), false);
});

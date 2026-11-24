// fusion-bootstrap profile resolution tests.
//
// The bootstrap picks the profile whose tier table it injects from the
// session's own directory, in the same precedence order as bin/oc
// (active_get_location / active_get_global) and profile-switcher
// (readActiveState), except that a record naming a profile without
// profiles/<name>/tiers.json is skipped as stale:
//   launched OPENCODE_CONFIG overlay > location record > global record > default
//
// Run: node --test plugin-src/fusion-bootstrap/test/

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseActiveProfile, resolveActiveProfile } from "../index.js";

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
  const root = mkdtempSync(path.join(TMP_BASE, "bootstrap-profile-test-"));
  roots.push(root);
  for (const name of ["cheap-local", "nightsense", "launched"]) {
    const dir = path.join(root, "profiles", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "opencode.jsonc"), "{}\n");
    writeFileSync(
      path.join(dir, "tiers.json"),
      JSON.stringify({ tiers: {}, agents: {} }, null, 2) + "\n",
    );
  }
  return root;
}

function writeState(configDir, lines) {
  writeFileSync(path.join(configDir, ".active-profile"), lines.join("\n") + "\n");
}

function makeDir(configDir, name) {
  const dir = path.join(configDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("parseActiveProfile reads v1 records and skips invalid lines", () => {
  const state = parseActiveProfile(
    [
      "location\t/a/one\tcheap-local",
      "global\tnightsense",
      "bogus line",
      "location\t/b/two\t../evil",
      "location\t\tdefault",
      "global\t../escape",
      "location\t/a/one\tdefault",
    ].join("\n"),
  );
  assert.deepEqual(state.locations, [
    { directory: "/a/one", name: "cheap-local" },
    { directory: "/a/one", name: "default" },
  ]);
  assert.equal(state.global, "nightsense");
});

test("parseActiveProfile reads a legacy single-line file as the global record", () => {
  assert.deepEqual(parseActiveProfile("cheap-local\n"), {
    global: "cheap-local",
    locations: [],
  });
  assert.deepEqual(parseActiveProfile("../escape"), { global: null, locations: [] });
  assert.deepEqual(parseActiveProfile(""), { global: null, locations: [] });
});

test("the launched overlay wins over every record", () => {
  const configDir = makeConfigDir();
  writeState(configDir, [
    "global\tnightsense",
    "location\t" + configDir + "\tcheap-local",
  ]);
  const env = {
    OPENCODE_CONFIG: path.join(configDir, "profiles", "launched", "opencode.jsonc"),
  };
  assert.equal(resolveActiveProfile(env, configDir, configDir), "launched");
});

test("a canonical (realpath) location match wins over the raw spelling", () => {
  const configDir = makeConfigDir();
  const real = makeDir(configDir, "real");
  const alias = path.join(configDir, "alias");
  symlinkSync(real, alias);
  writeState(configDir, [
    "global\tnightsense",
    "location\t" + alias + "\tnightsense",
    "location\t" + real + "\tcheap-local",
  ]);
  assert.equal(resolveActiveProfile({}, configDir, alias), "cheap-local");
});

test("a raw location match is the fallback when no canonical record matches", () => {
  const configDir = makeConfigDir();
  const real = makeDir(configDir, "real");
  const alias = path.join(configDir, "alias");
  symlinkSync(real, alias);
  writeState(configDir, [
    "global\tnightsense",
    "location\t" + alias + "\tcheap-local",
  ]);
  assert.equal(resolveActiveProfile({}, configDir, alias), "cheap-local");
});

test("later location records override earlier ones", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  writeState(configDir, [
    "location\t" + dir + "\tnightsense",
    "location\t" + dir + "\tcheap-local",
  ]);
  assert.equal(resolveActiveProfile({}, configDir, dir), "cheap-local");
});

test("the last usable global record is the fallback for an unrecorded directory", () => {
  const configDir = makeConfigDir();
  writeState(configDir, [
    "global\tnightsense",
    "location\t/somewhere/else\tcheap-local",
    "global\tcheap-local",
  ]);
  assert.equal(resolveActiveProfile({}, configDir, makeDir(configDir, "other")), "cheap-local");
});

test("a stale record without tiers.json is skipped for the next candidate", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  rmSync(path.join(configDir, "profiles", "nightsense", "tiers.json"));
  writeState(configDir, [
    "location\t" + dir + "\tnightsense",
    "global\tcheap-local",
  ]);
  assert.equal(resolveActiveProfile({}, configDir, dir), "cheap-local");
});

test("a stale global record falls through to default", () => {
  const configDir = makeConfigDir();
  rmSync(path.join(configDir, "profiles", "nightsense", "tiers.json"));
  writeState(configDir, ["global\tnightsense"]);
  assert.equal(resolveActiveProfile({}, configDir, makeDir(configDir, "work")), "default");
});

test("an invalid location name is skipped without touching the file", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  const text = ["location\t" + dir + "\t../evil", "global\tnightsense"].join("\n") + "\n";
  writeFileSync(path.join(configDir, ".active-profile"), text);
  assert.equal(resolveActiveProfile({}, configDir, dir), "nightsense");
  assert.equal(readFileSync(path.join(configDir, ".active-profile"), "utf8"), text);
});

test("no state file resolves to default", () => {
  const configDir = makeConfigDir();
  assert.equal(resolveActiveProfile({}, configDir, ""), "default");
  assert.equal(
    resolveActiveProfile({}, configDir, makeDir(configDir, "work")),
    "default",
  );
});

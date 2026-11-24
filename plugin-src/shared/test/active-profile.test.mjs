// shared active-profile resolver tests.
//
// Precedence: launched OPENCODE_CONFIG overlay > OC_PROFILE > canonical
// location record > raw location record > last usable global record >
// "default". profileExists rejects unusable candidates and resolution
// continues with the next one. The module never writes .active-profile.
//
// Run: node --test plugin-src/shared/test/

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

import {
  canonicalDirectory,
  detectLaunchedProfile,
  parseActiveProfile,
  parseActiveProfileText,
  resolveProfile,
} from "../active-profile.js";

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
  const root = mkdtempSync(path.join(TMP_BASE, "shared-active-profile-test-"));
  roots.push(root);
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

// Every test resolves without a profileExists callback unless it passes one:
// all names written are safe and syntactically valid.
const exists = () => true;

test("detectLaunchedProfile reads the profiles/<name>/opencode.jsonc shape", () => {
  assert.equal(
    detectLaunchedProfile({ OPENCODE_CONFIG: "/cfg/profiles/cheap-local/opencode.jsonc" }),
    "cheap-local",
  );
  assert.equal(detectLaunchedProfile({ OPENCODE_CONFIG: "/cfg/opencode.jsonc" }), null);
  assert.equal(detectLaunchedProfile({ OPENCODE_CONFIG: "/cfg/profiles/../evil/opencode.jsonc" }), null);
  assert.equal(detectLaunchedProfile({}), null);
});

test("parseActiveProfileText reads v1 records and skips invalid lines", () => {
  const state = parseActiveProfileText(
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

test("parseActiveProfileText reads a legacy single-line file as the global record", () => {
  assert.deepEqual(parseActiveProfileText("cheap-local\n"), {
    global: "cheap-local",
    locations: [],
  });
  assert.deepEqual(parseActiveProfileText("../escape"), { global: null, locations: [] });
  assert.deepEqual(parseActiveProfileText(""), { global: null, locations: [] });
});

test("parseActiveProfile reads the file and leaves it untouched", () => {
  const configDir = makeConfigDir();
  const text = "global\tcheap-local\nlocation\t/a/one\tnightsense\n";
  writeFileSync(path.join(configDir, ".active-profile"), text);
  assert.deepEqual(parseActiveProfile(configDir), {
    global: "cheap-local",
    locations: [{ directory: "/a/one", name: "nightsense" }],
  });
  assert.equal(readFileSync(path.join(configDir, ".active-profile"), "utf8"), text);
});

test("parseActiveProfile reads a legacy single-line file and tolerates a missing one", () => {
  const configDir = makeConfigDir();
  writeFileSync(path.join(configDir, ".active-profile"), "cheap-local\n");
  assert.deepEqual(parseActiveProfile(configDir), {
    global: "cheap-local",
    locations: [],
  });
  assert.deepEqual(parseActiveProfile(makeConfigDir()), { global: null, locations: [] });
});

test("canonicalDirectory resolves a symlink and falls back to the raw spelling", () => {
  const configDir = makeConfigDir();
  const real = makeDir(configDir, "real");
  const alias = path.join(configDir, "alias");
  symlinkSync(real, alias);
  assert.equal(canonicalDirectory(alias), real);
  assert.equal(canonicalDirectory(path.join(configDir, "missing")), path.join(configDir, "missing"));
  assert.equal(canonicalDirectory(""), "");
});

test("the launched overlay wins over every record and OC_PROFILE", () => {
  const configDir = makeConfigDir();
  writeState(configDir, [
    "global\tnightsense",
    "location\t" + configDir + "\tcheap-local",
  ]);
  const env = {
    OPENCODE_CONFIG: path.join(configDir, "profiles", "launched", "opencode.jsonc"),
    OC_PROFILE: "nightsense",
  };
  assert.equal(
    resolveProfile({ env, configDir, directory: configDir, profileExists: exists }),
    "launched",
  );
});

test("OC_PROFILE wins over a location record when the profile exists", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  writeState(configDir, ["location\t" + dir + "\tnightsense"]);
  assert.equal(
    resolveProfile({
      env: { OC_PROFILE: "cheap-local" },
      configDir,
      directory: dir,
      profileExists: (name) => name !== "nightsense",
    }),
    "cheap-local",
  );
});

test("an invalid OC_PROFILE falls through to the directory record", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  writeState(configDir, ["location\t" + dir + "\tnightsense"]);
  assert.equal(
    resolveProfile({
      env: { OC_PROFILE: "ghost" },
      configDir,
      directory: dir,
      profileExists: (name) => name === "nightsense",
    }),
    "nightsense",
  );
});

test("OC_PROFILE with an unsafe name is ignored", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  writeState(configDir, ["location\t" + dir + "\tcheap-local"]);
  assert.equal(
    resolveProfile({
      env: { OC_PROFILE: "../evil" },
      configDir,
      directory: dir,
      profileExists: exists,
    }),
    "cheap-local",
  );
});

test("OC_PROFILE does not persist: the state file is unchanged", () => {
  const configDir = makeConfigDir();
  const text = "global\tnightsense\n";
  writeFileSync(path.join(configDir, ".active-profile"), text);
  assert.equal(
    resolveProfile({ env: { OC_PROFILE: "cheap-local" }, configDir, directory: "", profileExists: exists }),
    "cheap-local",
  );
  assert.equal(readFileSync(path.join(configDir, ".active-profile"), "utf8"), text);
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
  assert.equal(
    resolveProfile({ env: {}, configDir, directory: alias, profileExists: exists }),
    "cheap-local",
  );
});

test("a raw location match is the fallback when no canonical record matches", () => {
  const configDir = makeConfigDir();
  const real = makeDir(configDir, "real");
  const alias = path.join(configDir, "alias");
  symlinkSync(real, alias);
  writeState(configDir, ["location\t" + alias + "\tcheap-local"]);
  assert.equal(
    resolveProfile({ env: {}, configDir, directory: alias, profileExists: exists }),
    "cheap-local",
  );
});

test("later location records override earlier ones", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  writeState(configDir, [
    "location\t" + dir + "\tnightsense",
    "location\t" + dir + "\tcheap-local",
  ]);
  assert.equal(
    resolveProfile({ env: {}, configDir, directory: dir, profileExists: exists }),
    "cheap-local",
  );
});

test("the last usable global record is the fallback for an unrecorded directory", () => {
  const configDir = makeConfigDir();
  writeState(configDir, [
    "global\tnightsense",
    "location\t/somewhere/else\tcheap-local",
    "global\tcheap-local",
  ]);
  assert.equal(
    resolveProfile({
      env: {},
      configDir,
      directory: makeDir(configDir, "other"),
      profileExists: exists,
    }),
    "cheap-local",
  );
});

test("a rejected location record is skipped for the next candidate", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  writeState(configDir, [
    "location\t" + dir + "\tnightsense",
    "global\tcheap-local",
  ]);
  assert.equal(
    resolveProfile({
      env: {},
      configDir,
      directory: dir,
      profileExists: (name) => name !== "nightsense",
    }),
    "cheap-local",
  );
});

test("a rejected global record falls through to default", () => {
  const configDir = makeConfigDir();
  writeState(configDir, ["global\tnightsense"]);
  assert.equal(
    resolveProfile({
      env: {},
      configDir,
      directory: makeDir(configDir, "work"),
      profileExists: (name) => name !== "nightsense",
    }),
    "default",
  );
});

test("an invalid location name is skipped without touching the file", () => {
  const configDir = makeConfigDir();
  const dir = makeDir(configDir, "work");
  const text = ["location\t" + dir + "\t../evil", "global\tnightsense"].join("\n") + "\n";
  writeFileSync(path.join(configDir, ".active-profile"), text);
  assert.equal(
    resolveProfile({ env: {}, configDir, directory: dir, profileExists: exists }),
    "nightsense",
  );
  assert.equal(readFileSync(path.join(configDir, ".active-profile"), "utf8"), text);
});

test("no state file resolves to default", () => {
  const configDir = makeConfigDir();
  assert.equal(
    resolveProfile({ env: {}, configDir, directory: "", profileExists: exists }),
    "default",
  );
  assert.equal(
    resolveProfile({
      env: {},
      configDir,
      directory: makeDir(configDir, "work"),
      profileExists: exists,
    }),
    "default",
  );
});

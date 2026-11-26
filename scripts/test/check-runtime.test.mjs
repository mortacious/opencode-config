// repo tooling tests: scripts/check-runtime.sh (kernel/debugger prerequisites).
//
// These live under the repo scripts/ test directory because `npm test` runs
// `node --test scripts/test/`; the script under test is repo tooling, not a
// plugin module.
//
// Every case runs the real script against a temporary PATH: a fake `npx`
// (exit 0, so the mcp-debugger doctor cannot reach the network) plus tiny
// Python shims that answer the `-c` probes. The real `node` stays on PATH
// because the script requires Node >= 22. No kernel is started and nothing is
// installed.
//
// Coverage:
//   1. --help exits 0 and prints the usage
//   2. an unknown flag exits 2
//   3. --python <good shim> passes (ipykernel + jupyter_client probes exit 0)
//   4. --python <bad shim> exits 1 with the ipykernel message
//   5. KERNEL_HOST_PYTHON=<bad shim> with a good --python exits 1 with the
//      jupyter_client message
//
// Run: node --test scripts/test/

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-runtime.sh");
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

// A shim body: exit `code`, printing a version line when it passes.
function shimSource(code) {
  if (code === 0) {
    return "#!/bin/sh\necho 3.11.9\nexit 0\n";
  }
  return "#!/bin/sh\nexit 1\n";
}

// makeShim PATH CODE - write an executable fake interpreter.
function makeShim(file, code) {
  writeFileSync(file, shimSource(code));
  chmodSync(file, 0o755);
}

// makePath() -> { dir, pathEnv, goodPy, badPy } with fake npx + two shims.
function makePath() {
  const dir = mkdtempSync(path.join(TMP_BASE, "check-runtime-"));
  roots.push(dir);
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);

  const npx = path.join(binDir, "npx");
  writeFileSync(npx, "#!/bin/sh\nexit 0\n");
  chmodSync(npx, 0o755);

  const goodPy = path.join(binDir, "python-ok");
  makeShim(goodPy, 0);
  const badPy = path.join(binDir, "python-bad");
  makeShim(badPy, 1);

  const pathEnv = `${binDir}:${process.env.PATH ?? ""}`;
  return { dir, pathEnv, goodPy, badPy };
}

function runScript(args, env) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 20000,
  });
}

test("--help exits 0 and prints usage", () => {
  const { pathEnv } = makePath();
  const result = runScript(["--help"], { PATH: pathEnv });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage: check-runtime\.sh/);
});

test("an unknown flag exits 2", () => {
  const { pathEnv } = makePath();
  const result = runScript(["--nope"], { PATH: pathEnv });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument: --nope/);
});

test("--python with ipykernel and jupyter_client passes", () => {
  const { pathEnv, goodPy } = makePath();
  const result = runScript(["--python", goodPy], { PATH: pathEnv });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime check passed/);
});

test("--python without ipykernel exits 1 with the ipykernel message", () => {
  const { pathEnv, badPy } = makePath();
  const result = runScript(["--python", badPy], { PATH: pathEnv });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /lacks ipykernel/);
});

test("KERNEL_HOST_PYTHON without jupyter_client exits 1 with the jupyter_client message", () => {
  const { pathEnv, goodPy, badPy } = makePath();
  const result = runScript(["--python", goodPy], {
    PATH: pathEnv,
    KERNEL_HOST_PYTHON: badPy,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /lacks jupyter_client/);
});

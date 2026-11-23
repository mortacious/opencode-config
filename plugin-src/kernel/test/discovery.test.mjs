import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultProbe, resolveKernel } from "../lib/discovery.js";

const IPYKERNEL_STUB =
  '#!/bin/sh\ncase "$2" in *ipykernel*) exit 0;; *) exit 1;; esac\n';
const BOTH_STUB =
  '#!/bin/sh\ncase "$2" in *ipykernel*|*jupyter_client*) exit 0;; *) exit 1;; esac\n';
const JUPYTER_STUB =
  '#!/bin/sh\ncase "$2" in *jupyter_client*) exit 0;; *) exit 1;; esac\n';
const FAIL_STUB = "#!/bin/sh\nexit 1\n";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kernel-discovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeStub(filePath, body) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  await chmod(filePath, 0o755);
  return filePath;
}

test("defaultProbe reports exit status without throwing", async (t) => {
  const dir = await tempDir(t);
  const ok = await makeStub(path.join(dir, "python-ok"), IPYKERNEL_STUB);
  const missing = path.join(dir, "does-not-exist");

  assert.equal(await defaultProbe(ok, "ipykernel"), true);
  assert.equal(await defaultProbe(ok, "jupyter_client"), false);
  assert.equal(await defaultProbe(missing, "ipykernel"), false);
  assert.equal(await defaultProbe(dir, "ipykernel"), false);
});

test("absolute requested python with ipykernel and jupyter_client is selected", async (t) => {
  const dir = await tempDir(t);
  const python = await makeStub(path.join(dir, "python-ok"), BOTH_STUB);

  const result = await resolveKernel({ requested: python, projectDir: dir, env: {} });

  assert.deepEqual(result, { kind: "python", selection: python, hostPython: python });
});

test("absolute requested python without ipykernel throws the install hint", async (t) => {
  const dir = await tempDir(t);
  const python = await makeStub(path.join(dir, "python-fail"), FAIL_STUB);

  await assert.rejects(
    resolveKernel({ requested: python, projectDir: dir, env: {} }),
    new Error(`${python} lacks ipykernel. Install it: ${python} -m pip install ipykernel`),
  );
});

test("absolute requested python without jupyter_client throws the install hint", async (t) => {
  const dir = await tempDir(t);
  const python = await makeStub(path.join(dir, "python-ipykernel-only"), IPYKERNEL_STUB);

  await assert.rejects(
    resolveKernel({ requested: python, projectDir: dir, env: {} }),
    new Error(
      `${python} lacks jupyter_client. Install it: ${python} -m pip install jupyter_client`,
    ),
  );
});

test("absolute requested path that is not executable throws", async (t) => {
  const dir = await tempDir(t);
  const python = path.join(dir, "not-executable");
  await writeFile(python, FAIL_STUB);

  await assert.rejects(
    resolveKernel({ requested: python, projectDir: dir, env: {} }),
    /is not an executable file/,
  );
  await assert.rejects(
    resolveKernel({ requested: path.join(dir, "absent"), projectDir: dir, env: {} }),
    /is not an executable file/,
  );
});

test("kernelspec name resolves a host python with jupyter_client", async (t) => {
  const dir = await tempDir(t);
  const calls = [];
  const probe = async (python, module) => {
    calls.push([python, module]);
    return module === "jupyter_client" && python === "python3";
  };

  const result = await resolveKernel({
    requested: "my-kernelspec",
    projectDir: dir,
    env: {},
    probe,
  });

  assert.deepEqual(result, {
    kind: "kernelspec",
    selection: "my-kernelspec",
    hostPython: "python3",
  });
  assert.deepEqual(calls.at(-1), ["python3", "jupyter_client"]);
  assert.ok(calls.every(([, module]) => module === "jupyter_client"));
});

test("kernelspec name prefers KERNEL_HOST_PYTHON for the host client", async (t) => {
  const calls = [];
  const probe = async (python, module) => {
    calls.push([python, module]);
    return module === "jupyter_client" && python === "/opt/host/python";
  };

  const result = await resolveKernel({
    requested: "my-kernelspec",
    projectDir: await tempDir(t),
    env: { KERNEL_HOST_PYTHON: "/opt/host/python", VIRTUAL_ENV: "/venv" },
    probe,
  });

  assert.deepEqual(result, {
    kind: "kernelspec",
    selection: "my-kernelspec",
    hostPython: "/opt/host/python",
  });
  assert.deepEqual(calls[0], ["/opt/host/python", "jupyter_client"]);
});

test("kernelspec name without any jupyter_client throws", async (t) => {
  const probe = async () => false;

  await assert.rejects(
    resolveKernel({
      requested: "my-kernelspec",
      projectDir: await tempDir(t),
      env: {},
      probe,
    }),
    new Error(
      "no Python with jupyter_client found; install it: python3 -m pip install jupyter_client",
    ),
  );
});

test("no request probes candidates in order and takes the first hit", async (t) => {
  const dir = await tempDir(t);
  const calls = [];
  const probe = async (python, module) => {
    calls.push([python, module]);
    return module === "ipykernel" && python === "/venv/bin/python";
  };

  const result = await resolveKernel({
    requested: "",
    projectDir: dir,
    env: { KERNEL_PYTHON: "/a/python", VIRTUAL_ENV: "/venv", CONDA_PREFIX: "/conda" },
    probe,
  });

  assert.deepEqual(result, {
    kind: "python",
    selection: "/venv/bin/python",
    hostPython: "/venv/bin/python",
  });
  assert.deepEqual(calls, [
    ["/a/python", "ipykernel"],
    ["/venv/bin/python", "ipykernel"],
  ]);
});

test("no request skips candidates that fail ipykernel", async (t) => {
  const dir = await tempDir(t);
  const venv = path.join(dir, "venv");
  const python = await makeStub(path.join(venv, "bin", "python"), IPYKERNEL_STUB);

  const result = await resolveKernel({
    requested: "",
    projectDir: dir,
    env: { KERNEL_PYTHON: "/missing/python" },
    probe: defaultProbe,
  });

  assert.deepEqual(result, { kind: "python", selection: python, hostPython: python });
});

test("no request without a usable python lists the candidates", async (t) => {
  const dir = await tempDir(t);

  await assert.rejects(
    resolveKernel({
      requested: "",
      projectDir: dir,
      env: { KERNEL_PYTHON: "/nowhere/python" },
      probe: async () => false,
    }),
    (error) => {
      assert.match(
        error.message,
        /^no Python with ipykernel found; install it in your env: \/nowhere\/python -m pip install ipykernel/,
      );
      assert.match(error.message, /Candidates checked:/);
      assert.match(error.message, /- \/nowhere\/python/);
      assert.match(error.message, /- python3/);
      return true;
    },
  );
});

test("candidates that share a realpath are probed once", async (t) => {
  const dir = await tempDir(t);
  const venvPython = await makeStub(
    path.join(dir, ".venv", "bin", "python"),
    IPYKERNEL_STUB,
  );
  await mkdir(path.join(dir, "venv", "bin"), { recursive: true });
  await symlink(venvPython, path.join(dir, "venv", "bin", "python"));

  const calls = [];
  const probe = async (python, module) => {
    calls.push([python, module]);
    return module === "ipykernel";
  };

  const result = await resolveKernel({
    requested: "",
    projectDir: dir,
    env: { VIRTUAL_ENV: path.join(dir, ".venv") },
    probe,
  });

  assert.equal(result.selection, venvPython);
  assert.deepEqual(calls, [[venvPython, "ipykernel"]]);
});

test("named kernelspec selection keeps the name verbatim", async () => {
  const result = await resolveKernel({
    requested: "  python3  ",
    projectDir: os.tmpdir(),
    env: {},
    probe: async (python, module) => module === "jupyter_client" && python === "python3",
  });

  assert.equal(result.kind, "kernelspec");
  assert.equal(result.selection, "python3");
});

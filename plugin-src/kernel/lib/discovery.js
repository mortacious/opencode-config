import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

const PROBE_TIMEOUT_MS = 5000;
const IPYKERNEL_MODULE = "ipykernel";
const JUPYTER_MODULE = "jupyter_client";

/**
 * Run `<python> -c "import <module>"` and report whether it exits 0.
 * Never throws: a missing binary, a timeout, or a spawn failure is a false.
 */
export function defaultProbe(python, module, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let child;
    try {
      child = spawn(python, ["-c", `import ${module}`], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(false);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

function candidateList({ projectDir, env }) {
  const found = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim() !== "") found.push(value);
  };

  push(env.KERNEL_PYTHON);
  if (env.VIRTUAL_ENV) push(path.join(env.VIRTUAL_ENV, "bin", "python"));
  if (env.CONDA_PREFIX) push(path.join(env.CONDA_PREFIX, "bin", "python"));
  if (projectDir) push(path.join(projectDir, ".venv", "bin", "python"));
  if (projectDir) push(path.join(projectDir, "venv", "bin", "python"));
  push("python3");

  return found;
}

async function uniqueCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    let key;
    try {
      key = await realpath(candidate);
    } catch {
      key = path.resolve(candidate);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return unique;
}

async function assertExecutableFile(python) {
  try {
    const info = await stat(python);
    if (info.isFile()) {
      await access(python, fsConstants.X_OK);
      return;
    }
  } catch {
    // fall through to the shared error
  }
  throw new Error(`${python} is not an executable file`);
}

async function firstWith({ candidates, module, probe }) {
  for (const candidate of candidates) {
    if (await probe(candidate, module)) return candidate;
  }
  return null;
}

/**
 * Resolve which interpreter launches the kernel host.
 *
 * `requested` is an absolute Python path, a kernelspec name, or empty.
 */
export async function resolveKernel({
  requested = "",
  projectDir = process.cwd(),
  env = process.env,
  probe = defaultProbe,
} = {}) {
  const request = typeof requested === "string" ? requested.trim() : "";
  const candidates = await uniqueCandidates(candidateList({ projectDir, env }));

  if (request !== "") {
    if (path.isAbsolute(request)) {
      await assertExecutableFile(request);
      const hasIpykernel = await probe(request, IPYKERNEL_MODULE);
      if (!hasIpykernel) {
        throw new Error(
          `${request} lacks ipykernel. Install it: ${request} -m pip install ipykernel`,
        );
      }
      const hasJupyter = await probe(request, JUPYTER_MODULE);
      if (!hasJupyter) {
        throw new Error(
          `${request} lacks jupyter_client. Install it: ${request} -m pip install jupyter_client`,
        );
      }
      return { kind: "python", selection: request, hostPython: request };
    }

    const hostCandidates = await uniqueCandidates(
      typeof env.KERNEL_HOST_PYTHON === "string" && env.KERNEL_HOST_PYTHON.trim() !== ""
        ? [env.KERNEL_HOST_PYTHON, ...candidates]
        : candidates,
    );
    const hostPython = await firstWith({
      candidates: hostCandidates,
      module: JUPYTER_MODULE,
      probe,
    });
    if (!hostPython) {
      throw new Error(
        "no Python with jupyter_client found; install it: python3 -m pip install jupyter_client",
      );
    }
    return { kind: "kernelspec", selection: request, hostPython };
  }

  const selection = await firstWith({
    candidates,
    module: IPYKERNEL_MODULE,
    probe,
  });
  if (selection) {
    return { kind: "python", selection, hostPython: selection };
  }

  const hint = candidates[0] ?? "python3";
  const listed = candidates.map((candidate) => `  - ${candidate}`).join("\n");
  throw new Error(
    `no Python with ipykernel found; install it in your env: ${hint} -m pip install ipykernel` +
      (listed ? `\nCandidates checked:\n${listed}` : ""),
  );
}

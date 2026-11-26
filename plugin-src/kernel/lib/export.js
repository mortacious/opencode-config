// Export-only host invocation.
//
// `kernel_export` never needs a live kernel: it spawns the host script with
// --export-only and reads the single JSON line the host prints. The journal
// and meta may belong to an evicted session, so nothing here touches the
// registry.

import { spawn } from "node:child_process";

export function defaultExportPython(env = process.env) {
  return typeof env.PYTHON_EXPORT === "string" && env.PYTHON_EXPORT !== ""
    ? env.PYTHON_EXPORT
    : "python3";
}

export function exportArgs({ hostScript, journal, meta, out, title }) {
  const args = [
    "-u",
    hostScript,
    "--export-only",
    "--journal",
    journal,
    "--meta",
    meta,
    "--out",
    out,
  ];
  if (typeof title === "string" && title !== "") args.push("--title", title);
  return args;
}

function lastJsonLine(stdout) {
  const lines = String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // keep looking: stderr noise and warnings may share stdout
    }
  }
  return null;
}

export function exportNotebook({
  python,
  hostScript,
  journal,
  meta,
  out,
  title,
  spawn: spawnImpl = spawn,
  timeoutMs = 120000,
} = {}) {
  const exe =
    typeof python === "string" && python !== "" ? python : defaultExportPython();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(exe, exportArgs({ hostScript, journal, meta, out, title }), {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
            finish(reject, new Error(`kernel export timed out after ${timeoutMs} ms`));
          }, timeoutMs)
        : null;
    if (timer && typeof timer.unref === "function") timer.unref();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(reject, new Error(`kernel export failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      const parsed = lastJsonLine(stdout);
      if (!parsed) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        finish(reject, new Error(`kernel export failed: ${detail}`));
        return;
      }
      if (parsed.ok !== true) {
        finish(reject, new Error(parsed.error || `kernel export failed: exit code ${code}`));
        return;
      }
      finish(resolve, {
        ok: true,
        path: parsed.path,
        cells: parsed.cells,
        truncated: parsed.truncated === true,
      });
    });
  });
}

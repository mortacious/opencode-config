// fusion-tools: structured JSON-lines logger.
// Appends to ${HOME}/.local/state/opencode/fusion-tools.log via node:fs.
// Best-effort: never throws, creates the directory on demand.
// Promise plugins in v2.0.18 cannot reach the opencode log file (upstream
// anomalyco/opencode#27285), so this private file is the observable log:
// {ts, service, module, level, msg, ...extra}.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const STATE_DIR = path.join(homedir(), ".local", "state", "opencode");
const LOG_FILE = path.join(STATE_DIR, "fusion-tools.log");

let dirReady = false;

function ensureDir() {
  if (dirReady) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    dirReady = true;
  } catch {
    // best-effort only
  }
}

export function logFile() {
  return LOG_FILE;
}

// entry: {module, level, msg, ...extra}. Never throws.
// Also mirrors to console.log (harmless; not captured into the opencode log
// file for Promise plugins, but visible in foreground server output).
export function log(entry) {
  if (!entry || typeof entry !== "object") return;
  const rec = { ts: new Date().toISOString(), service: "fusion-tools", ...entry };
  let line;
  try {
    line = JSON.stringify(rec) + "\n";
  } catch {
    // cyclic/non-serializable extra: do not throw over logging
    return;
  }
  try {
    console.log(line.trim());
  } catch {
    // ignore
  }
  try {
    appendFileSync(LOG_FILE, line);
    return;
  } catch {
    // fall through to the dir-creation retry
  }
  ensureDir();
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // still failing - give up silently
  }
}

// Small safety net: truncates string extras so a huge delta never lands in
// the log file whole.
export async function logSafe(entry, extra) {
  const safe = {};
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      safe[k] = typeof v === "string" ? v.slice(0, 200) : v;
    }
  }
  log({ ...entry, ...safe });
}

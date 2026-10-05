// subagent-view: OpenCode v2 server plugin entry (plugin id "subagent-view").
//
// TUI-only plugin. All behavior lives in tui.tsx, which restores v1's live
// subagent token/context display as a "Subagents (n)" sidebar section (the v2
// regression is upstream #42367 / #38495). This server entry is a minimal
// no-op so the package's "." export loads cleanly: it logs one INFO line and
// returns. The logging sink mirrors the lumo-supervisor/profile-switcher JSONL
// pattern (console + appendFileSync, lazy mkdir, never-throw) but is kept tiny.
//
// All files ASCII only.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Plugin } from "@opencode/plugin";

const SERVICE = "subagent-view";

const STATE_DIR = join(homedir(), ".local", "state", SERVICE);
const LOG_FILE = join(STATE_DIR, SERVICE + ".log");

// Tiny JSONL logger: console AND appended line in LOG_FILE. Never throws.
function log(message: string): void {
  let line: string;
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      service: SERVICE,
      level: "info",
      message,
    });
  } catch {
    return;
  }
  try {
    console.log(line);
  } catch {
    // logging must never break setup
  }
  try {
    appendFileSync(LOG_FILE, line + "\n");
    return;
  } catch {
    // fall through to the dir-creation retry
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // best-effort only
  }
}

export default Plugin.define({
  id: "subagent-view",
  setup() {
    log("subagent-view server entry loaded (TUI-only plugin)");
  },
});

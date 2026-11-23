// Per-session state layout for the kernel plugin.
//
// Root: $XDG_STATE_HOME/opencode/kernel, or ~/.local/state/opencode/kernel.
// Every session owns <root>/<sessionID> with images/ and logs/ subdirs, the
// JSONL journal at cells.jsonl, and the kernelspec/language metadata at
// meta.json. Session ids come from the server; they are validated because
// they become directory names.

import os from "node:os";
import path from "node:path";

export function assertSessionID(sessionID) {
  if (typeof sessionID !== "string" || sessionID.trim() === "") {
    throw new Error("kernel requires a session id");
  }
  if (sessionID.includes("/") || sessionID.includes("\\") || sessionID.includes("..")) {
    throw new Error(`invalid session id: ${sessionID}`);
  }
  return sessionID;
}

export function stateRoot(env = process.env, home = os.homedir()) {
  const xdg =
    typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim() !== ""
      ? env.XDG_STATE_HOME
      : path.join(home, ".local", "state");
  return path.join(xdg, "opencode", "kernel");
}

export function sessionPaths(sessionID, { root } = {}) {
  assertSessionID(sessionID);
  const dir = path.join(root ?? stateRoot(), sessionID);
  return {
    dir,
    imagesDir: path.join(dir, "images"),
    logsDir: path.join(dir, "logs"),
    journal: path.join(dir, "cells.jsonl"),
    meta: path.join(dir, "meta.json"),
  };
}

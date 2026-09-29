// fusion-tools: git worktree helpers for the fanout module.
//
// All git access goes through execFile with argument arrays - no shell
// string interpolation, no shell: true. Every call is bounded by a timeout
// and resolves (never throws) with a plain result object.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_WORKTREE_BASE = path.join(
  homedir(),
  ".cache",
  "opencode",
  "fusion-tools",
  "worktrees",
);

const GIT_TIMEOUT_MS = 30000;
const MAX_BUFFER = 4 * 1024 * 1024;

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          code: err && typeof err.code === "number" ? err.code : null,
        });
      },
    );
  });
}

// Lowercased, filesystem-safe label for the worktree directory name.
export function sanitizeTaskName(name) {
  if (typeof name !== "string") return "task";
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "task";
}

export function resolveWorktreeBase(configured) {
  if (typeof configured === "string" && configured.trim()) return configured;
  return DEFAULT_WORKTREE_BASE;
}

export async function isInsideGitRepo(dir) {
  const r = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
  return r.ok && r.stdout.trim() === "true";
}

export async function createWorktree(repoDir, worktreePath) {
  const r = await runGit(
    ["-C", repoDir, "worktree", "add", "--detach", worktreePath, "HEAD"],
    repoDir,
  );
  return { ok: r.ok, stderr: (r.stderr || r.stdout).trim() };
}

// diffStat for a finished worker: stage everything (best effort, so newly
// created files show up), then diff the worktree against its HEAD.
export async function diffStat(worktreePath) {
  await runGit(["add", "-A", "--"], worktreePath);
  const r = await runGit(["diff", "--stat", "HEAD", "--"], worktreePath);
  if (!r.ok) return null;
  const s = r.stdout.trim();
  return s || null;
}

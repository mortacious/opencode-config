// Live smoke for the kernel plugin against the real opencode 2.3.2 TUI.
//
// This is deliberately NOT a node --test file: it drives the installed CLI, a
// real model call, a real Jupyter kernel, and a real tmux pane. It proves the
// path a user takes, not a seam:
//
//   1. uv venv (3.14, falling back to 3.12, then a plain `uv venv`) with
//      matplotlib, ipykernel, and jupyter_client.
//   2. `opencode run --standalone --auto --session <id> --format json` in a
//      throwaway project, with an isolated XDG_STATE_HOME and KERNEL_PYTHON.
//      The prompt asks for exactly one `kernel` call running
//      `%matplotlib inline` + `plt.show()`, and only one paid run is ever
//      started; a failed run is reported, never retried.
//   3. Assert the plugin journal (read with the plugin's own lib/journal.js)
//      holds a completed cell with an image/png display output, that the PNG
//      was saved under images/, that lib/panel.js maps it to an image part,
//      and that ImageMagick (`magick identify`, falling back to `identify`)
//      calls it a PNG.
//   4. Open the same session in a detached tmux pane running
//      `opencode --standalone --session <id>`, assert the transcript shows the
//      literal `image: <absolute png path>` line for the validated PNG, send
//      `/kernel`, and assert the panel header and cell label built from the
//      journal meta.json and lib/panel.js render.
//
// Transcript detail: the TUI collapses a completed tool call and its output.
// The pane therefore runs with `session.verbosity` high (inline CLI setting,
// not a config edit), which renders the `kernel [code=...]` call row; one
// synthetic click on that row expands it, and the expanded output carries both
// the journal cell's `In[n]` result header and the `image: <path>.png` line the
// harness asserts on.
//
// Session detail: `opencode run --session <id>` lands the session in the
// shared opencode session DB (tmp XDG_STATE_HOME does not isolate it), while
// all kernel state (journals, images, venv) stays under the temp dir. The
// harness therefore prints the session id plus the exact cleanup commands,
// tmux kill-session first, then `opencode session delete <id>`, then
// `rm -rf <temp dir>`; it never runs them itself. The kill comes first because
// the pane deliberately ends with `exec sh`, so removing the temp dir while the
// TUI is alive would delete its cwd.
//
// Every tmux capture is written under caps/. The tmux session is never killed,
// so a failure can be inspected in place and a success can be confirmed by eye.
//
// All files ASCII only.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { readJournal } from "../lib/journal.js";
import { cellLabel, outputParts, panelHeader } from "../lib/panel.js";

const TEMP_ROOT = "/tmp/opencode";
const CELL_CODE = [
  "%matplotlib inline",
  "import matplotlib.pyplot as plt",
  "plt.plot([1, 4, 9, 16])",
  "plt.show()",
].join("\n");

const PROMPT = [
  "Call the `kernel` tool exactly once yourself, then stop.",
  "Do not delegate, do not call any other tool, and do not read or write files.",
  "Pass this exact `code` argument (four lines, keep the leading %magic line):",
  "",
  CELL_CODE,
  "",
  "Reply with the single word done.",
].join("\n");

const AGENT = "orchestrator";
const RUN_TIMEOUT_MS = 300_000;
// The journal can receive its last line just after the CLI exits, so a run
// that ends without an image cell keeps the journal under watch for this
// bounded settle window; the overall wait is the run budget plus the settle.
const JOURNAL_SETTLE_MS = 30_000;
const JOURNAL_TIMEOUT_MS = RUN_TIMEOUT_MS + JOURNAL_SETTLE_MS;
const EXIT_GRACE_MS = 60_000;
const TRANSCRIPT_TIMEOUT_MS = 90_000;
const PANEL_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const POLL_MS = 1_500;
const MAX_CLICKS = 3;

const TRANSCRIPT_IMAGE_PREFIX = "image: ";
// What an expanded tool call renders above its output; a row already showing
// it must not be clicked again (a second click collapses it).
const EXPANDED_OUTPUT_MARKER = "output:";
// The `/kernel` slash entry from tui.tsx (title "Kernel cells").
const KERNEL_COMMAND_DESCRIPTION = "Show this session's kernel cells";

class SmokeError extends Error {
  constructor(assertion, detail) {
    super(detail === undefined ? assertion : `${assertion}: ${detail}`);
    this.assertion = assertion;
  }
}

function require_(condition, assertion, detail) {
  if (!condition) throw new SmokeError(assertion, detail);
}

function log(line = "") {
  process.stdout.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(text, lines = 40, width = 300) {
  const all = String(text ?? "")
    .split("\n")
    .map((line) => (line.length > width ? `${line.slice(0, width)}...` : line));
  return all.slice(-lines).join("\n");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function resolveBinary(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  const found = (result.stdout ?? "").trim();
  return result.status === 0 && found !== "" ? found : null;
}

// ImageMagick 7 ships `magick identify`; ImageMagick 6 only has `identify`.
// Both are candidates: a `magick` binary whose identify subcommand exits
// non-zero may still have a usable standalone `identify`.
function resolveIdentifyTools() {
  const tools = [];
  const magick = resolveBinary("magick");
  if (magick !== null) tools.push({ bin: magick, prefix: ["identify"], name: "magick identify" });
  const identify = resolveBinary("identify");
  if (identify !== null) tools.push({ bin: identify, prefix: [], name: "identify" });
  return tools;
}

function identifyPng(tools, file) {
  const attempts = [];
  for (const tool of tools) {
    const result = spawnSync(tool.bin, [...tool.prefix, "-format", "%m %wx%h", file], {
      encoding: "utf8",
    });
    if (result.status === 0) {
      return { tool, info: (result.stdout ?? "").trim(), attempts };
    }
    attempts.push(`${tool.name}: ${tail(result.stderr, 5)}`);
  }
  return { tool: null, info: "", attempts };
}

// `opencode --version` prints "v2.3.2"; compare the numeric triple so a
// pre-release suffix or a bare version both work.
function versionAtLeast(text, minimum) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  if (match === null) return false;
  const got = [Number(match[1]), Number(match[2]), Number(match[3])];
  const want = minimum.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    if (got[index] > want[index]) return true;
    if (got[index] < want[index]) return false;
  }
  return true;
}

const state = {
  tempDir: null,
  capsDir: null,
  sessionID: null,
  tmuxName: null,
  journalPath: null,
  png: null,
  runLogs: [],
  activeRun: null,
};

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

async function createVenv(venvDir) {
  // 3.14 and 3.12 are the versions known good for the host's written checks;
  // a plain `uv venv` is the last resort on machines with neither. Create,
  // install, and probe are one candidate attempt: any failure moves to the
  // next interpreter, and only the full set failing is an error.
  const candidates = ["3.14", "3.12", null];
  const failures = [];
  for (const version of candidates) {
    const label = version ?? "default";
    await rm(venvDir, { recursive: true, force: true });
    const args = version === null ? ["venv", venvDir] : ["venv", "--python", version, venvDir];
    const created = spawnSync("uv", args, {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (created.status !== 0) {
      failures.push(`${label}: uv venv: ${tail(created.stderr || created.stdout, 10)}`);
      log(`  uv ${args.slice(0, 2).join(" ")} failed; trying the next interpreter`);
      continue;
    }
    const python = path.join(venvDir, "bin", "python");
    const probe = spawnSync(python, ["-c", "import sys; print(sys.version.split()[0])"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (probe.status !== 0) {
      failures.push(`${label}: python probe: ${tail(probe.stderr, 10)}`);
      log(`  python ${label} probe failed; trying the next interpreter`);
      continue;
    }
    const install = spawnSync(
      "uv",
      ["pip", "install", "--python", python, "matplotlib", "ipykernel", "jupyter_client"],
      { encoding: "utf8", timeout: 600_000 },
    );
    if (install.status !== 0) {
      failures.push(`${label}: uv pip install: ${tail(install.stderr || install.stdout, 20)}`);
      log(`  uv pip install failed on python ${label}; trying the next interpreter`);
      continue;
    }
    const imports = spawnSync(
      python,
      ["-c", "import matplotlib, ipykernel, jupyter_client; print('imports ok')"],
      { encoding: "utf8", timeout: 60_000 },
    );
    if (imports.status !== 0) {
      failures.push(`${label}: python imports: ${tail(imports.stderr, 10)}`);
      log(`  python imports failed on ${label}; trying the next interpreter`);
      continue;
    }
    log(`  venv: python ${label} (${probe.stdout.trim()})`);
    return python;
  }
  throw new SmokeError(
    "uv venv with matplotlib, ipykernel, jupyter_client",
    failures.join(" | ") || "no candidate interpreter could be prepared",
  );
}

// ---------------------------------------------------------------------------
// opencode run
// ---------------------------------------------------------------------------

function startOpencode({ bin, args, logFile, cwd, env, timeoutMs }) {
  const fd = openSync(logFile, "w");
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ["ignore", fd, fd],
  });
  const runState = { exited: false, code: null, signal: null, error: null };
  let killTimer = null;

  const signalChild = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  // SIGTERM first; a CLI that ignores it gets SIGKILL five seconds later so
  // neither the timeout path nor the failure path can hang on the child.
  const terminate = () => {
    signalChild("SIGTERM");
    if (killTimer === null) {
      killTimer = setTimeout(() => signalChild("SIGKILL"), KILL_GRACE_MS);
    }
  };

  const timer = setTimeout(terminate, timeoutMs);

  const done = new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      resolve(runState);
    };
    child.on("error", (err) => {
      runState.error = err.message;
      runState.exited = true;
      finish();
    });
    child.on("exit", (code, signal) => {
      runState.exited = true;
      runState.code = code;
      runState.signal = signal;
      finish();
    });
  });

  return {
    logFile,
    state: runState,
    done,
    kill: terminate,
    // Failure path: stop the child and wait for it to be gone (SIGKILL bounds
    // the wait) so node can exit without abandoning a paid run.
    async stop() {
      if (runState.exited) return runState;
      terminate();
      await done;
      return runState;
    },
  };
}

function runArgs(sessionID, prompt) {
  return [
    "run",
    "--standalone",
    "--auto",
    "--session",
    sessionID,
    "--title",
    "kernel-live-smoke",
    "--format",
    "json",
    "--agent",
    AGENT,
    prompt,
  ];
}

async function waitForExit(run, timeoutMs) {
  if (run.state.exited) return run.state;
  const timer = setTimeout(() => run.kill(), timeoutMs);
  await run.done;
  clearTimeout(timer);
  return run.state;
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

function imagePayload(cell) {
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  for (const output of outputs) {
    if (!output || typeof output !== "object") continue;
    if (output.output_type !== "display_data" && output.output_type !== "execute_result") {
      continue;
    }
    const data = output.data;
    if (!data || typeof data !== "object") continue;
    const encoded = data["image/png"];
    if (typeof encoded === "string" && encoded !== "") return encoded;
  }
  return null;
}

// The panel header comes from lib/panel.js itself, rebuilt from the journal
// meta.json so a changed journal (other language, other selection, more cells)
// is asserted as it really is instead of against a hardcoded string.

async function scanJournals(stateDir) {
  const root = path.join(stateDir, "opencode", "kernel");
  const sessions = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { root, sessions };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const paths = {
      dir,
      journal: path.join(dir, "cells.jsonl"),
      meta: path.join(dir, "meta.json"),
    };
    let snapshot;
    try {
      snapshot = await readJournal(paths);
    } catch {
      continue; // a half-written journal line is a transient state
    }
    const cells = Array.isArray(snapshot.cells) ? snapshot.cells : [];
    const cell = cells.find((record) => record && record.type === "cell" && imagePayload(record));
    sessions.push({ sessionID: entry.name, paths, meta: snapshot.meta, cells, cell });
  }
  return { root, sessions };
}

async function waitForImageCell({ stateDir, sessionID, timeoutMs, settleMs, run }) {
  const deadline = Date.now() + timeoutMs;
  let settleDeadline = null;
  for (;;) {
    const scan = await scanJournals(stateDir);
    const match = scan.sessions.find((session) => session.sessionID === sessionID && session.cell);
    if (match) return match;
    if (run.state.exited) {
      // The CLI can exit a beat before the journal's last line lands; keep
      // polling for the bounded settle window instead of declaring failure.
      if (settleDeadline === null) settleDeadline = Date.now() + settleMs;
      if (Date.now() >= settleDeadline) return null;
    } else if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// tmux
// ---------------------------------------------------------------------------

function startTui({ tmuxName, projectDir, stateDir, python, sessionID, opencodeBin }) {
  const command = [
    "env",
    "-u",
    "OPENCODE_SESSION_ID",
    "-u",
    "OPENCODE_CONFIG",
    // The pane inherits the harness env, whose OPENCODE_CONFIG_CONTENT may
    // steer the CLI; the TUI sets its own content explicitly for verbosity.
    "-u",
    "OPENCODE_CONFIG_CONTENT",
    // opencode resolves its project directory from PWD, not from the process
    // cwd, so the throwaway project must be named explicitly.
    `PWD=${shellQuote(projectDir)}`,
    `XDG_STATE_HOME=${shellQuote(stateDir)}`,
    `KERNEL_PYTHON=${shellQuote(python)}`,
    // Inline CLI setting (not a config file edit, not OPENCODE_CONFIG): the
    // transcript must show the tool call row so it can be expanded.
    `OPENCODE_CLI_CONFIG_CONTENT=${shellQuote(JSON.stringify({ session: { verbosity: "high" } }))}`,
    shellQuote(opencodeBin),
    "--standalone",
    "--session",
    shellQuote(sessionID),
  ].join(" ");
  // The trailing shell keeps the pane (and the tmux session) alive even if
  // opencode exits; the harness never kills it either way.
  const wrapped = `${command}; exec sh`;
  const created = spawnSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      tmuxName,
      "-x",
      "200",
      "-y",
      "50",
      "-c",
      projectDir,
      "sh",
      "-c",
      wrapped,
    ],
    { encoding: "utf8" },
  );
  require_(created.status === 0, "tmux new-session", tail(created.stderr, 10));
}

// The TUI accepts xterm SGR mouse reports and `tmux send-keys -l` writes them
// straight into the pane, so no real pointer is needed. Row and column are
// 1-based pane cells.
function clickRow(tmuxName, row, col = 8) {
  const sequence = `\u001b[<0;${col};${row}M\u001b[<0;${col};${row}m`;
  spawnSync("tmux", ["send-keys", "-t", tmuxName, "-l", sequence], { encoding: "utf8" });
}

// At session.verbosity high the transcript renders the call as one expandable
// row containing `kernel [code=...]`; at the default low verbosity the whole
// call collapses into "+ N tool" and there is nothing to click. `expanded`
// reports whether the text below the row already shows its output, so a row
// that is open is never clicked closed again.
function inspectToolRow(text) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("kernel [code=")) continue;
    const below = lines.slice(index + 1).join("\n");
    return { row: index + 1, expanded: below.includes(EXPANDED_OUTPUT_MARKER) };
  }
  return { row: 0, expanded: false };
}

function makeCapture(tmuxName, capsDir) {
  let seq = 0;
  return async function capture(label) {
    seq += 1;
    const result = spawnSync("tmux", ["capture-pane", "-p", "-t", tmuxName], {
      encoding: "utf8",
    });
    const text = result.stdout ?? "";
    const file = path.join(capsDir, `tui-${String(seq).padStart(4, "0")}-${label}.txt`);
    await writeFile(file, text);
    return text;
  };
}

async function waitForText({ capture, timeoutMs, label, check }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await capture(label);
    if (check(text)) return text;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  // Epoch + pid + randomness: `--session <id>` silently reuses an existing
  // id, so a collision would assert against a stale journal from another run.
  const epoch = Math.floor(startedAt / 1000);
  const runTag = `${epoch}_${process.pid}_${randomBytes(2).toString("hex")}`;
  const sessionID = `ses_kernel_live_${runTag}`;
  const tmuxName = `kernel-live-${runTag.replace(/_/g, "-")}`;
  state.sessionID = sessionID;

  for (const tool of ["uv", "tmux", "opencode"]) {
    require_(resolveBinary(tool) !== null, `required tool: ${tool}`, "not found on PATH");
  }
  const identifyTools = resolveIdentifyTools();
  require_(
    identifyTools.length > 0,
    "required tool: magick or identify",
    "neither is on PATH",
  );
  // Use the one resolved binary for every CLI invocation so PATH order cannot
  // differ between the version check and the paid run.
  const opencodeBin = resolveBinary("opencode");
  const versionCheck = spawnSync(opencodeBin, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const versionText = `${versionCheck.stdout ?? ""}${versionCheck.stderr ?? ""}`.trim();
  require_(
    versionCheck.status === 0 && versionAtLeast(versionText, "2.3.0"),
    "opencode version",
    `this repo needs opencode >= 2.3.0; ${opencodeBin} reported ${versionText || "nothing"} (exit ${String(versionCheck.status)})`,
  );
  log(`  opencode: ${versionText} (${opencodeBin})`);

  await mkdir(TEMP_ROOT, { recursive: true });
  const tempDir = await mkdtemp(path.join(TEMP_ROOT, "kernel-live-"));
  const projectDir = path.join(tempDir, "project");
  const stateDir = path.join(tempDir, "state");
  const capsDir = path.join(tempDir, "caps");
  await mkdir(projectDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(capsDir, { recursive: true });
  state.tempDir = tempDir;
  state.capsDir = capsDir;
  log(`[1/8] temp dir: ${tempDir}`);

  log("[2/8] uv venv + matplotlib");
  const python = await createVenv(path.join(tempDir, "venv"));

  // Never inherit an OPENCODE_CONFIG overlay and never set one: the installed
  // repo config (~/.config/opencode/opencode.jsonc) is the path under test.
  // A config-content overlay is scrubbed for the same reason; the tmux env
  // restores verbosity explicitly below.
  const baseEnv = { ...process.env };
  delete baseEnv.OPENCODE_SESSION_ID;
  delete baseEnv.OPENCODE_CONFIG;
  delete baseEnv.OPENCODE_CONFIG_CONTENT;
  delete baseEnv.OPENCODE_CLI_CONFIG_CONTENT;
  const childEnv = {
    ...baseEnv,
    // opencode resolves its project directory from PWD; spawn's cwd does not
    // update it.
    PWD: projectDir,
    XDG_STATE_HOME: stateDir,
    KERNEL_PYTHON: python,
  };

  log(`[3/8] opencode run (agent ${AGENT}, session ${sessionID})`);
  const runLog = path.join(capsDir, "run.jsonl");
  state.runLogs.push(runLog);
  const run = startOpencode({
    bin: opencodeBin,
    args: runArgs(sessionID, PROMPT),
    logFile: runLog,
    cwd: projectDir,
    env: childEnv,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  state.activeRun = run;

  log("[4/8] waiting for the journal cell with an image/png display output");
  const hit = await waitForImageCell({
    stateDir,
    sessionID,
    timeoutMs: JOURNAL_TIMEOUT_MS,
    settleMs: JOURNAL_SETTLE_MS,
    run,
  });
  await waitForExit(run, EXIT_GRACE_MS);
  state.activeRun = null;
  require_(
    run.state.error === null,
    "opencode run",
    `could not start the CLI: ${run.state.error}`,
  );
  require_(
    hit !== null,
    "kernel cell with image/png display output",
    `no completed cell with an image/png; run output: ${tail(await safeRead(runLog), 40)}`,
  );

  state.journalPath = hit.paths.journal;
  log(`  journal: ${hit.paths.journal}`);

  const scan = await scanJournals(stateDir);
  const stray = scan.sessions.filter((session) => session.sessionID !== sessionID && session.cell);
  require_(
    stray.length === 0,
    "journal session",
    `cell landed in ${stray.map((session) => session.sessionID).join(", ")}, not ${sessionID}`,
  );
  require_(
    String(hit.cell.source ?? "").includes("%matplotlib") &&
      String(hit.cell.source ?? "").includes("plt.plot"),
    "journal cell source",
    `unexpected source: ${JSON.stringify(String(hit.cell.source ?? "").slice(0, 160))}`,
  );
  const parts = outputParts(hit.cell);
  require_(
    parts.some((part) => part.kind === "image"),
    "journal image render part",
    `lib/panel.js outputParts has no image part: ${JSON.stringify(parts.map((part) => part.kind))}`,
  );
  const payload = imagePayload(hit.cell);
  require_(
    typeof payload === "string" && payload.startsWith("iVBOR"),
    "journal image/png payload",
    "display output has no base64 PNG payload",
  );
  require_(
    typeof hit.cell.execution_count === "number" && hit.cell.execution_count >= 1,
    "journal execution_count",
    `got ${String(hit.cell.execution_count)}`,
  );
  require_(
    hit.meta !== null && typeof hit.meta === "object",
    "journal meta.json",
    "missing or invalid meta.json",
  );
  const cellIndex = hit.cells.indexOf(hit.cell);
  const panelHeaderText = panelHeader(hit.meta, hit.cells);
  const panelLabel = cellLabel(hit.cell, cellIndex);

  log("[5/8] saved PNG + identify");
  const imagesDir = path.join(hit.paths.dir, "images");
  let pngFiles = [];
  try {
    pngFiles = (await readdir(imagesDir)).filter((name) => name.endsWith(".png")).sort();
  } catch {
    pngFiles = [];
  }
  require_(pngFiles.length > 0, "saved PNG under images/", `no .png in ${imagesDir}`);
  const identifyLines = [];
  for (const name of pngFiles) {
    const file = path.join(imagesDir, name);
    const identified = identifyPng(identifyTools, file);
    require_(
      identified.tool !== null,
      "PNG identify",
      `${file}: ${identified.attempts.join(" | ") || "no ImageMagick tool available"}`,
    );
    const info = identified.info;
    identifyLines.push(`${name}: ${info} (${identified.tool.name})`);
    require_(
      info.startsWith("PNG"),
      `${identified.tool.name} reports PNG`,
      `${name}: ${info}`,
    );
  }
  state.png = path.join(imagesDir, pngFiles[0]);
  await writeFile(path.join(capsDir, "identify.txt"), `${identifyLines.join("\n")}\n`);
  for (const line of identifyLines) log(`  ${line}`);

  log("[6/8] tmux TUI on the same session");
  startTui({
    tmuxName,
    projectDir,
    stateDir,
    python,
    sessionID,
    opencodeBin,
  });
  // Only advertise the name once the session exists; a failed new-session must
  // not produce a cleanup hint for a session that was never created.
  state.tmuxName = tmuxName;
  const capture = makeCapture(tmuxName, capsDir);
  const expectedImageLine = `${TRANSCRIPT_IMAGE_PREFIX}${state.png}`;
  // The expanded call must show the same cell's result header. The count comes
  // from the journal record the image checks above accepted. The host renders
  // its own `output:` prefix and padding on the same line as the label
  // (`       output: In[1]`), so the pattern matches the label at a token
  // boundary instead of a whole line; In[10] still cannot satisfy In[1].
  const resultHeader = `In[${hit.cell.execution_count}]`;
  const resultHeaderPattern = new RegExp(
    `(^|[\\s:])In\\[${hit.cell.execution_count}\\](?=\\s|$)`,
  );

  log("[7/8] transcript: the validated image path");
  // The transcript hides a completed call's output until the call row is
  // expanded: verbosity high renders the row, one click opens it. Click at
  // most three times and never on a row whose output is already visible.
  const transcriptDeadline = Date.now() + TRANSCRIPT_TIMEOUT_MS;
  const hasImageLine = (text) => text.includes(expectedImageLine);
  const hasResultHeader = (text) => resultHeaderPattern.test(text);
  const hasCellView = (text) => hasImageLine(text) && hasResultHeader(text);
  let transcript = "";
  let clicks = 0;
  let sawToolRow = false;
  for (;;) {
    transcript = await capture("transcript");
    if (hasCellView(transcript)) break;
    const toolRow = inspectToolRow(transcript);
    if (toolRow.row > 0) sawToolRow = true;
    if (toolRow.row > 0 && !toolRow.expanded && clicks < MAX_CLICKS) {
      clicks += 1;
      clickRow(tmuxName, toolRow.row);
      await sleep(800);
      transcript = await capture("transcript-expanded");
      if (hasCellView(transcript)) break;
    }
    if (Date.now() >= transcriptDeadline) break;
    await sleep(POLL_MS);
  }
  require_(
    sawToolRow,
    "transcript tool row",
    `the kernel call row never rendered within ${TRANSCRIPT_TIMEOUT_MS / 1000}s; captures in ${capsDir}`,
  );
  require_(
    hasImageLine(transcript),
    "transcript image path",
    `no "${TRANSCRIPT_IMAGE_PREFIX}<png path>" for ${state.png} within ${TRANSCRIPT_TIMEOUT_MS / 1000}s after ${clicks} click(s); captures in ${capsDir}`,
  );
  require_(
    hasResultHeader(transcript),
    `transcript ${resultHeader} result header`,
    `no "${resultHeader}" result header within ${TRANSCRIPT_TIMEOUT_MS / 1000}s after ${clicks} click(s); captures in ${capsDir}`,
  );

  log("[8/8] /kernel panel: header + cell label");
  // "/kernel" and Enter must be separate writes: the slash menu needs a beat
  // to list the command before Enter commits it.
  spawnSync("tmux", ["send-keys", "-t", tmuxName, "/kernel"], { encoding: "utf8" });
  const menu = await waitForText({
    capture,
    timeoutMs: PANEL_TIMEOUT_MS,
    label: "slash-menu",
    check: (text) => text.includes(KERNEL_COMMAND_DESCRIPTION),
  });
  require_(
    menu !== null,
    "slash command registered",
    `"/kernel" (${KERNEL_COMMAND_DESCRIPTION}) never appeared; captures in ${capsDir}`,
  );
  spawnSync("tmux", ["send-keys", "-t", tmuxName, "Enter"], { encoding: "utf8" });
  const panel = await waitForText({
    capture,
    timeoutMs: PANEL_TIMEOUT_MS,
    label: "panel",
    check: (text) => text.includes(panelHeaderText) && text.includes(panelLabel),
  });
  require_(
    panel !== null,
    "kernel panel markers",
    `missing ${JSON.stringify([panelHeaderText, panelLabel])} within ${PANEL_TIMEOUT_MS / 1000}s; captures in ${capsDir}`,
  );

  log("");
  log(
    `KERNEL LIVE SMOKE: PASS (journal + transcript + panel + PNG header); confirm the plot by eye: tmux attach -t ${tmuxName}`,
  );
  log(`session:   ${sessionID}`);
  log(`journal:   ${hit.paths.journal}`);
  log(`png:       ${state.png} (${identifyLines.join("; ")})`);
  log(`transcript marker: ${JSON.stringify(expectedImageLine)}`);
  log(`panel markers: ${JSON.stringify([panelHeaderText, panelLabel])}`);
  log(`tmux:      tmux attach -t ${tmuxName}`);
  log("cleanup (after you have confirmed the pixels by eye):");
  log(`           tmux kill-session -t ${tmuxName} 2>/dev/null || true`);
  log(`           opencode session delete ${sessionID}`);
  log(`           rm -rf ${tempDir}`);
  log(`captures:  ${capsDir}`);
  log(`elapsed:   ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return 0;
}

async function safeRead(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function printFailure(error) {
  const failure =
    error instanceof SmokeError
      ? error
      : new SmokeError("harness", error && error.stack ? error.stack : String(error));
  process.stderr.write("\nKERNEL LIVE SMOKE: FAIL\n");
  process.stderr.write(`assertion: ${failure.assertion}\n`);
  process.stderr.write(`detail:    ${failure.message}\n`);
  if (state.sessionID !== null) process.stderr.write(`session:   ${state.sessionID}\n`);
  if (state.capsDir !== null) process.stderr.write(`captures:  ${state.capsDir}\n`);
  if (state.tempDir !== null) process.stderr.write(`temp:      ${state.tempDir}\n`);
  if (state.journalPath !== null) process.stderr.write(`journal:   ${state.journalPath}\n`);
  if (state.tmuxName !== null) {
    process.stderr.write(`tmux:      tmux attach -t ${state.tmuxName}\n`);
  }
  if (state.tempDir !== null) {
    // The kill must come first: the pane ends with `exec sh`, so removing the
    // temp dir under a live TUI would delete that shell's cwd.
    process.stderr.write("cleanup (after you have confirmed the pixels by eye):\n");
    if (state.tmuxName !== null) {
      process.stderr.write(
        `           tmux kill-session -t ${state.tmuxName} 2>/dev/null || true\n`,
      );
    }
    process.stderr.write(`           opencode session delete ${String(state.sessionID)}\n`);
    process.stderr.write(`           rm -rf ${state.tempDir}\n`);
  }
  for (const file of state.runLogs) {
    const text = await safeRead(file);
    if (text === "") continue;
    process.stderr.write(`run output (last 40 lines of ${file}):\n${tail(text, 40)}\n`);
  }
  if (state.activeRun !== null) {
    process.stderr.write("note: stopping the in-flight opencode run (the tmux session is kept)\n");
    const final = await state.activeRun.stop();
    process.stderr.write(`run exit:  code=${String(final.code)} signal=${String(final.signal)}\n`);
  }
}

// A signal must not abandon a paid run. The handler stops the child (SIGTERM,
// then SIGKILL after KILL_GRACE_MS), prints the same failure block the error
// path prints, and exits 1; a second signal while that runs is ignored.
function installSignalHandlers() {
  let handling = false;
  const handler = (signal) => {
    if (handling) return;
    handling = true;
    void printFailure(new SmokeError("signal", `${signal} received; the run is not retried`))
      .catch(() => {})
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

installSignalHandlers();

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (error) => {
    await printFailure(error);
    process.exitCode = 1;
  });

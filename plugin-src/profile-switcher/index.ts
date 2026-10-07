// profile-switcher: OpenCode v2 server plugin (plugin id "profile-switcher").
//
// In-session profile switching with hot-swapped agent models - no service
// restart. Profiles stay declarative overlay files under
// profiles/<name>/opencode.jsonc; this plugin applies the MODEL SUBSET of an
// overlay as live runtime transforms:
//   - An agent model transform owned by this plugin applies a CAPTURED
//     per-agent model map. Transforms run in registration order over a shared
//     editor, and the core config-agent plugin registers its own model
//     transform only AFTER plugin setup, so applyProfile() disposes the
//     previous registration and registers a fresh one each time (Set
//     re-insertion appends it): the profile transform always runs last and
//     wins. For "default" the captured map is the BASE refs captured at
//     setup, restoring base models explicitly.
//   - applyProfile(name) reads profiles/<name>/opencode.jsonc (JSONC: full-line
//     // comments, /* */ blocks, trailing commas - never throws), maps
//     agents.<id>.model (+optional variant) and small_model -> the built-in
//     "title" agent, warns "not hot-swappable: <key>" for any other top-level
//     key, re-resolves each target against an availability snapshot, updates
//     the captured map, re-registers the agent transform, writes
//     .active-profile and emits the
//     "changed" RPC event.
//   - Availability + fallback: every target is checked against a snapshot Set
//     of "providerID/modelID" from ctx.model.list(). Exact-match miss with a
//     modelFallbacks hit substitutes the fallback (applied: fallback:true);
//     a miss without fallback warns and leaves the agent unchanged.
//   - provider.updated / model.updated events (ctx.event.subscribe) refresh the
//     snapshot and re-run applyProfile for the current active profile -
//     debounced ~2s, and ONLY when the re-resolved outcome differs from what
//     is applied. Skipped entirely when the active profile came from launch
//     detection.
//
// State sharing: CONFIG_DIR/.active-profile is the SAME file bin/oc reads and
// writes, so the bash launcher and this plugin stay in sync. Format v1 is a
// tab-separated record set: an optional machine-wide "global" fallback record
// plus one "location\t<absDir>\t<name>" record per directory. Each plugin
// instance owns the record for its own directory, so two TUI windows in
// different directories hold independent active profiles; a legacy single-line
// file (no tabs) is read as the global record. A "changed" broadcast converges
// only instances whose directory matches, and session migration is scoped to
// the sessions a TUI window currently claims as open tabs (plus sessions
// created in this location) - never another workspace's history. A TUI may
// also push an explicit claim refresh for its window - including an empty set,
// which prunes the window's closed tabs - via a top-level window id on
// populate (per-entry window ids alone cannot express an empty set). The file
// is never rewritten at setup; only rpc set() persists, atomically (temp file
// + rename) after re-reading the current file so a write never clobbers
// another location.
//
// Launch detection: when the service was started by bin/oc,
// OPENCODE_CONFIG points at CONFIG_DIR/profiles/<name>/opencode.jsonc - the
// overlay is already merged into the base config, so runtimeActive = <name>
// and NO transforms are applied (and no state file is read or written).
//
// Logging: console.log AND appendFileSync to
// ~/.local/state/profile-switcher/profile-switcher.log (JSONL, lazy mkdir,
// never-throw) - mirrors the lumo-supervisor log() pattern. Never logs key
// material (this plugin never reads keys).
//
// Options (ctx.options): profilesDir (default CONFIG_DIR/profiles), modelFallbacks
// (default { "lumo-tamer/lumo-max": "Amenable Thor 1/qwen38-flash-next" }).
//
// Agent model contract (verified against the installed @opencode/plugin
// typings): Agent.Info.model is a STRUCTURED Model.Ref
// ({ id, providerID, variant? }) - not a "provider/model#variant" string - so
// the transform assigns Model.Ref.parse(ref) output verbatim.
//
// All files ASCII only.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Model, Plugin } from "@opencode/plugin";

import { readProfileFile, type ProfileModelEntry } from "./parse.js";
import {
  Profile,
  type ProfileAgentModelEntry,
  type ProfileAppliedEntry,
  type ProfileListEntry,
  type ProfilePopulateInput,
  type ProfilePopulateSession,
  type ProfileSetResult,
} from "./rpc.js";

const SERVICE = "profile-switcher";

// CONFIG_DIR from import.meta.url: this file lives at
// <CONFIG_DIR>/plugin-src/profile-switcher/index.ts, so ../.. is CONFIG_DIR -
// the same "script dir -> parent" walk bin/oc does with readlink -f.
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(PLUGIN_DIR, "..", "..");

const DEFAULT_PROFILES_DIR = join(CONFIG_DIR, "profiles");
// Shared single-line state file with bin/oc (bin/oc: ACTIVE_FILE).
const ACTIVE_FILE = join(CONFIG_DIR, ".active-profile");

const STATE_DIR = join(homedir(), ".local", "state", SERVICE);
const LOG_FILE = join(STATE_DIR, SERVICE + ".log");

const DEFAULT_MODEL_FALLBACKS: Readonly<Record<string, string>> = {
  "lumo-tamer/lumo-max": "Amenable Thor 1/qwen38-flash-next",
};

// Debounce for provider.updated / model.updated re-evaluation.
const REEVAL_DEBOUNCE_MS = 2000;

// One-shot delay before re-asserting the active profile after setup, once the
// core config-agent transform has registered (see the initial-application
// block in setup()).
const SETTLE_DELAY_MS = 4000;

// Last directory successfully created for LOG_FILE (lazy mkdir, mirrors
// lumo-supervisor's logDirReady).
let logDirReady = false;

// Structured logging: console AND appended JSONL line in LOG_FILE with fields
// {ts, service, level, message, ...extra} - the established lumo-supervisor
// pattern. Never throws, never prints key material.
function log(
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  let line: string;
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      service: SERVICE,
      level,
      message,
      ...(extra ?? {}),
    });
  } catch {
    return;
  }
  try {
    console.log(line);
  } catch {
    // logging must never break setup or cleanup
  }
  try {
    appendFileSync(LOG_FILE, line + "\n");
    return;
  } catch {
    // fall through to the dir-creation retry
  }
  if (!logDirReady) {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      logDirReady = true;
    } catch {
      // best-effort only
    }
  }
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // still failing - give up silently
  }
}

function expandTilde(target: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  return target;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Profile names come from rpc set() input and .active-profile: a single path
// segment, never a traversal.
function isSafeProfileName(name: string): boolean {
  if (!name) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes(sep)) return false;
  return true;
}

// TUI window claim id: an opaque token (schema ^[A-Za-z0-9_-]+$, 1-64 chars).
// Anything else is treated as a legacy payload with no window.
function isWindowId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

// Launched-profile detection: bin/oc exports
// OPENCODE_CONFIG=<CONFIG_DIR>/profiles/<name>/opencode.jsonc. Detected under
// CONFIG_DIR/profiles (the path bin/oc hardcodes as PROFILES_DIR), regardless
// of the profilesDir option.
function detectLaunchedProfile(): string | undefined {
  const raw = process.env.OPENCODE_CONFIG;
  if (!raw) return undefined;
  let target: string;
  try {
    target = resolve(expandTilde(raw));
  } catch {
    return undefined;
  }
  const prefix = join(CONFIG_DIR, "profiles") + sep;
  if (!target.startsWith(prefix)) return undefined;
  const parts = target.slice(prefix.length).split(sep);
  if (parts.length !== 2 || parts[1] !== "opencode.jsonc") return undefined;
  if (!isSafeProfileName(parts[0])) return undefined;
  return parts[0];
}

// Canonicalize a directory for .active-profile record matching: realpathSync
// resolves symlinks so two spellings of the same directory converge. On any
// failure (missing path, permissions) fall back to the raw value.
function canonicalizeDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

// Why a record name is unusable, or undefined when it can actually be applied:
// a safe single path segment naming an existing profile overlay, or the
// literal "default" (an explicit per-directory default is meaningful even
// without a default/ overlay on disk).
function recordNameIssue(
  profilesDir: string,
  name: string
): string | undefined {
  if (!isSafeProfileName(name)) {
    return (
      "invalid profile name in .active-profile: " + JSON.stringify(name)
    );
  }
  if (name === "default") return undefined;
  if (!existsSync(join(profilesDir, name, "opencode.jsonc"))) {
    return (
      'unknown profile "' + name + '" in .active-profile (file left unchanged)'
    );
  }
  return undefined;
}

interface ParsedActiveState {
  // Validated machine-wide fallback record, when present.
  global?: string;
  // Validated per-directory records in file order.
  locations: Array<{ directory: string; name: string }>;
  warning?: string;
}

// Parse .active-profile content WITHOUT rewriting it. Format v1:
//   global\t<name>
//   location\t<absDir>\t<name>
// A file whose text contains no tab is the legacy single-line global form.
// Invalid, unsafe or unknown records are skipped and collected into a single
// warning; unreachable records read as absent. Blank lines are ignored.
function parseActiveStateFile(
  profilesDir: string,
  rawText: string
): ParsedActiveState {
  const locations: Array<{ directory: string; name: string }> = [];
  const issues: string[] = [];
  const trimmed = rawText.trim();
  if (!trimmed) return { locations };
  if (!rawText.includes("\t")) {
    const issue = recordNameIssue(profilesDir, trimmed);
    if (!issue) return { global: trimmed, locations };
    return { locations, warning: issue };
  }
  let global: string | undefined;
  for (const line of rawText.split("\n")) {
    const record = line.trim();
    if (!record) continue;
    const parts = record.split("\t");
    if (parts[0] === "global" && parts.length === 2) {
      const issue = recordNameIssue(profilesDir, parts[1]);
      if (!issue) global = parts[1];
      else issues.push(issue);
      continue;
    }
    if (parts[0] === "location" && parts.length === 3) {
      if (!parts[1]) {
        issues.push("empty directory in .active-profile location record");
        continue;
      }
      const issue = recordNameIssue(profilesDir, parts[2]);
      if (!issue) {
        locations.push({ directory: parts[1], name: parts[2] });
      } else {
        issues.push(issue + " for " + JSON.stringify(parts[1]));
      }
      continue;
    }
    issues.push(
      "unrecognized line in .active-profile: " + JSON.stringify(record)
    );
  }
  return {
    ...(global !== undefined ? { global } : {}),
    locations,
    ...(issues.length > 0 ? { warning: issues.join("; ") } : {}),
  };
}

// Reads the shared .active-profile state file for THIS instance. Precedence:
// the record for realpathSync(ownDirectory), then raw ownDirectory, then the
// global record, then "default". Missing/empty -> "default" (no warning - the
// absent file is the normal default state). Invalid/unknown names warn and are
// skipped WITHOUT rewriting the file. `global` is returned so setup can carry
// the legacy machine-wide record forward on the first persist.
function readActiveState(
  profilesDir: string,
  ownDirectory?: string
): {
  name: string;
  global?: string;
  warning?: string;
} {
  let rawText: string;
  try {
    rawText = readFileSync(ACTIVE_FILE, "utf8");
  } catch {
    return { name: "default" };
  }
  const parsed = parseActiveStateFile(profilesDir, rawText);
  let name = "default";
  let matched = false;
  if (ownDirectory) {
    const canonical = canonicalizeDirectory(ownDirectory);
    // Later records override earlier ones for the same directory.
    for (const record of parsed.locations) {
      if (record.directory === canonical) {
        name = record.name;
        matched = true;
      }
    }
    if (!matched) {
      for (const record of parsed.locations) {
        if (record.directory === ownDirectory) {
          name = record.name;
          matched = true;
        }
      }
    }
  }
  if (!matched && parsed.global !== undefined) {
    name = parsed.global;
  }
  return {
    name,
    ...(parsed.global !== undefined ? { global: parsed.global } : {}),
    ...(parsed.warning !== undefined ? { warning: parsed.warning } : {}),
  };
}

function readFallbacks(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return { ...DEFAULT_MODEL_FALLBACKS };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [key, target] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (typeof target === "string" && target) out[key] = target;
    }
    return out;
  }
  log("warn", "modelFallbacks option is not an object; using defaults", {
    received: typeof value,
  });
  return { ...DEFAULT_MODEL_FALLBACKS };
}

// One entry of the outcome that is "currently applied": the resolved model
// map (agent -> final ref) plus parallel applied[]/warnings for RPC results.
interface Resolution {
  map: Map<string, string>;
  applied: ProfileAppliedEntry[];
  warnings: string[];
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

// Normalize a structured model ref to the canonical "providerID/id#variant"
// form used throughout this plugin; the "default" variant is dropped (it means
// "model default", i.e. no variant).
function normalizeModelRef(ref: {
  providerID?: unknown;
  id?: unknown;
  variant?: unknown;
} | null | undefined): string | undefined {
  if (!ref) return undefined;
  const providerID = ref.providerID;
  const id = ref.id;
  if (typeof providerID !== "string" || typeof id !== "string") {
    return undefined;
  }
  const variant = ref.variant;
  return (
    providerID +
    "/" +
    id +
    (typeof variant === "string" && variant && variant !== "default"
      ? "#" + variant
      : "")
  );
}

// Strip the "#variant" suffix from a normalized ref, giving provider/id
// equality. Used by the migration consent guard so variant-carrying sessions
// (e.g. a TUI-seeded "provider/id#max") still match a base pin "provider/id".
function baseModelRef(ref: string): string {
  return ref.split("#")[0];
}

// One tracked session (roots AND child/subagent sessions). Both migrate under
// the same consent rules; a running session keeps its model until it goes idle.
interface TrackedSession {
  agent?: string;
  model?: string;
  parentID?: string;
  running: boolean;
  // Set once a TUI window claim covers this session. Entries that were never
  // claimed (fed only by session.created, or by legacy no-window payloads) are
  // never pruned; claimed entries are pruned as soon as no current claim set
  // contains them.
  claimed?: boolean;
}

// Tracker bound: exceeding this clears the map AND the claim sets (populate
// re-seeds both).
const MAX_TRACKED_SESSIONS = 5000;

function eventLocationDirectory(event: unknown): string | undefined {
  const location = (event as { location?: { directory?: unknown } } | null)
    ?.location;
  const directory = location?.directory;
  if (typeof directory === "string") return directory;
  // Fallback: the optional top-level location is absent, so read the
  // payload location instead (non-empty string only).
  const payloadLocation = (
    event as { data?: { location?: { directory?: unknown } } } | null
  )?.data?.location;
  const payloadDirectory = payloadLocation?.directory;
  return typeof payloadDirectory === "string" && payloadDirectory
    ? payloadDirectory
    : undefined;
}

export default Plugin.define({
  id: "profile-switcher",
  async setup(ctx) {
    const raw = (ctx.options ?? {}) as Record<string, unknown>;
    const profilesDir = resolve(
      expandTilde(
        typeof raw.profilesDir === "string" && raw.profilesDir
          ? raw.profilesDir
          : DEFAULT_PROFILES_DIR
      )
    );
    const modelFallbacks = readFallbacks(raw.modelFallbacks);

    log("info", "setup (load/reload)", {
      configDir: CONFIG_DIR,
      profilesDir,
      fallbackKeys: Object.keys(modelFallbacks),
    });

    // ---- active profile resolution -------------------------------------
    let activeName = "default";
    // This instance's location directory: the scope for state records,
    // convergence and session migration.
    const ownDirectory = ctx.location?.directory;
    // Machine-wide legacy global record read at setup, carried forward by the
    // first persist so the format conversion does not drop it.
    let legacyGlobal: string | undefined;
    // True only while the active profile came from launch detection: the base
    // config already carries that overlay, so no transforms and no event
    // re-evaluation. Cleared by a successful rpc set().
    let launchSuppressed = false;
    const launched = detectLaunchedProfile();
    if (launched !== undefined) {
      activeName = launched;
      launchSuppressed = true;
      log(
        "info",
        "launched under a profile overlay via OPENCODE_CONFIG; base config owns models - skipping transforms, state file untouched",
        { active: activeName }
      );
    } else {
      const state = readActiveState(profilesDir, ownDirectory);
      activeName = state.name;
      legacyGlobal = state.global;
      if (state.warning) log("warn", state.warning, { active: activeName });
    }

    // ---- captured state -------------------------------------------------
    // Availability snapshot: "providerID/modelID" set from ctx.model.list().
    let availability = new Set<string>();
    // Captured per-agent model map applied by the current transform.
    let captured = new Map<string, string>();
    // Base per-agent model refs captured once BEFORE any profile transform is
    // registered; "default" restores these explicitly. The base config file
    // (CONFIG_DIR/opencode.jsonc) is the primary source: a registry read
    // (ctx.agent.list()) at plugin setup sees the pre-config-pipeline state -
    // the core config-agent transform has not registered yet, so agents list
    // with no usable model. The registry is only a fallback for an unreadable
    // base config.
    const baseModels = new Map<string, string>();

    // ---- session tracker -----------------------------------------------
    // Root sessions whose persisted model may be rewritten when a profile is
    // applied. Fed by the single event subscription below and seeded by the
    // `populate` RPC: the handler broadcasts clean entries through this
    // plugin's own rpc event, and every instance seeds the entries whose
    // location equals its own directory (a module-scope registry cannot span
    // instances - each gets an isolated module copy).
    const tracked = new Map<string, TrackedSession>();
    // TUI window id -> the session ids that window currently claims in THIS
    // location. Applied wholesale per populate, so windows in the same
    // directory never bleed into each other; the union drives claim pruning.
    const claims = new Map<string, Set<string>>();
    // Serializes migrations so overlapping profile switches cannot interleave
    // switchModel calls for the same session.
    let migrationChain: Promise<void> = Promise.resolve();

    function locationMismatch(directory: string | undefined): boolean {
      // Ignore an event only when it carries a location AND that location
      // differs from this plugin's own location. No location -> accept.
      if (!directory) return false;
      if (!ownDirectory) return false;
      return directory !== ownDirectory;
    }

    function enforceTrackerBound(): void {
      if (tracked.size > MAX_TRACKED_SESSIONS) {
        log("warn", "session tracker exceeded bound; clearing", {
          size: tracked.size,
        });
        tracked.clear();
        claims.clear();
      }
    }

    // Seed one session into THIS instance's tracker. The populate event
    // handler calls this only for entries whose location equals this
    // instance's own directory, so the tracker stays per-location. `claim`
    // marks the entry as covered by a TUI window claim, which makes it
    // eligible for pruning once no current claim set contains it.
    function seedSession(
      input: {
        sessionID: string;
        agent?: string;
        model?: string;
        parentID?: string;
      },
      claim: boolean
    ): boolean {
      const existing = tracked.get(input.sessionID);
      if (existing) {
        if (claim) existing.claimed = true;
        return false;
      }
      tracked.set(input.sessionID, {
        agent: input.agent,
        model: input.model,
        parentID: input.parentID,
        running: false,
        ...(claim ? { claimed: true } : {}),
      });
      enforceTrackerBound();
      return true;
    }

    // Drop tracked sessions that were claimed at least once and are absent
    // from the union of all current window claim sets. Entries with no claim
    // (fed only by session.created or legacy no-window payloads) are never
    // pruned.
    function pruneReleasedClaims(): void {
      const current = new Set<string>();
      for (const ids of claims.values()) {
        for (const id of ids) current.add(id);
      }
      for (const [sessionID, session] of tracked) {
        if (session.claimed && !current.has(sessionID)) {
          tracked.delete(sessionID);
        }
      }
    }

    // Consume one event into the session tracker. Returns true when the event
    // type is handled (the caller then skips the provider/model path).
    function handleSessionEvent(event: {
      type: string;
      data?: unknown;
      location?: { directory?: unknown };
    }): boolean {
      const type = event.type;
      const data = event.data as
        | {
            sessionID?: unknown;
            agent?: unknown;
            model?: unknown;
            parentID?: unknown;
          }
        | undefined;
      const sessionID = data?.sessionID;
      if (typeof sessionID !== "string") {
        // Handled type but no usable id: swallow rather than fall through.
        return type.startsWith("session.");
      }
      if (locationMismatch(eventLocationDirectory(event))) return true;
      switch (type) {
        case "session.created": {
          const existing = tracked.get(sessionID);
          tracked.set(sessionID, {
            agent: typeof data?.agent === "string" ? data.agent : undefined,
            model: normalizeModelRef(
              data?.model as
                | { providerID?: unknown; id?: unknown; variant?: unknown }
                | null
                | undefined
            ),
            parentID:
              typeof data?.parentID === "string" ? data.parentID : undefined,
            running: false,
            // A claim that already covers this session must survive the
            // create event, or the entry would become unprunable-forever.
            ...(existing?.claimed ? { claimed: true } : {}),
          });
          enforceTrackerBound();
          return true;
        }
        case "session.agent.selected": {
          const entry = tracked.get(sessionID);
          if (entry && typeof data?.agent === "string") entry.agent = data.agent;
          return true;
        }
        case "session.model.selected": {
          const entry = tracked.get(sessionID);
          if (entry) {
            const model = normalizeModelRef(
              data?.model as
                | { providerID?: unknown; id?: unknown; variant?: unknown }
                | null
                | undefined
            );
            if (model !== undefined) entry.model = model;
          }
          return true;
        }
        case "session.deleted": {
          tracked.delete(sessionID);
          return true;
        }
        case "session.execution.started": {
          const entry = tracked.get(sessionID);
          if (entry) entry.running = true;
          return true;
        }
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted": {
          const entry = tracked.get(sessionID);
          if (entry) entry.running = false;
          return true;
        }
        default:
          return false;
      }
    }

    // Capture the base per-agent model map. Deterministic and independent of
    // the config-pipeline race: the base config file is parsed directly (the
    // same parser used for profile overlays), so it does not depend on the
    // core config-agent transform having registered. The registry read is only
    // a fallback for an unreadable base config. Idempotent: clears first so a
    // re-capture never leaves stale entries. Never throws.
    async function captureBaseModels(): Promise<void> {
      baseModels.clear();
      // PRIMARY: parse the base config file exactly like a profile overlay.
      let configEntries: ProfileModelEntry[] | undefined;
      try {
        const parsed = readProfileFile(join(CONFIG_DIR, "opencode.jsonc"));
        // The base config legitimately carries many non-model keys (the
        // "not hot-swappable" warnings); discard them silently.
        configEntries = parsed.entries;
      } catch (err) {
        log("warn", "failed to read base config; falling back to registry", {
          error: errorText(err),
        });
      }
      if (configEntries !== undefined) {
        if (configEntries.length > 0) {
          for (const entry of configEntries) {
            baseModels.set(entry.agent, entry.ref);
          }
          log("info", "base models captured", {
            source: "config",
            count: baseModels.size,
          });
          return;
        }
        log("warn", "base config yielded no agent model pins");
      }
      // FALLBACK: registry read. Best-effort - at setup it may see the
      // pre-config-pipeline state and capture nothing.
      try {
        const res = await ctx.agent.list();
        for (const agent of res.data) {
          const model = agent.model;
          if (!model) continue;
          baseModels.set(
            agent.id,
            model.providerID +
              "/" +
              model.id +
              (model.variant ? "#" + model.variant : "")
          );
        }
      } catch (err) {
        log("warn", "failed to capture base agent models", {
          error: errorText(err),
        });
      }
      log("info", "base models captured", {
        source: "registry",
        count: baseModels.size,
      });
    }

    // The map a given profile should end up applying: the resolved overlay
    // targets, or the captured base refs for "default".
    function targetMap(
      name: string,
      resolvedMap: Map<string, string>
    ): Map<string, string> {
      return name === "default" ? new Map(baseModels) : resolvedMap;
    }

    // Effective per-agent model map for the sidebar, as { agent, model } rows
    // sorted by agent. baseModels underlies BOTH branches because the transform
    // only overrides the agents present in captured - every other agent keeps
    // its base-config model - so the base map is the floor for the full
    // picture. With captured entries (the transform-applied state, including
    // after an in-session switch in a formerly launch-suppressed instance) the
    // captured entries win on top of baseModels. While captured is empty (the
    // launch-suppressed initial state, where no transform ran because the base
    // config already carries the overlay) the RAW overlay entries are overlaid
    // on baseModels in file order - the same precedence the config deep-merge
    // used at launch; an unreadable overlay yields baseModels alone. Never
    // throws; returns whatever was computable (empty array as last resort).
    function currentAgentModels(): ProfileAgentModelEntry[] {
      try {
        const map = new Map<string, string>();
        for (const [agent, ref] of baseModels) map.set(agent, ref);
        if (captured.size > 0) {
          for (const [agent, ref] of captured) map.set(agent, ref);
        } else {
          try {
            const parsed = readProfileFile(
              join(profilesDir, activeName, "opencode.jsonc")
            );
            for (const entry of parsed.entries) {
              map.set(entry.agent, entry.ref);
            }
          } catch {
            // Overlay unreadable: base models alone.
          }
        }
        const entries: ProfileAgentModelEntry[] = [];
        for (const [agent, model] of map) entries.push({ agent, model });
        entries.sort((a, b) =>
          a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0
        );
        return entries;
      } catch {
        return [];
      }
    }

    let cleanedUp = false;
    let emitChanged: ((active: string) => Promise<void>) | undefined;
    let disposeRpc: (() => Promise<void>) | undefined;
    let reevalTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    // Serialization guard for THIS plugin's rpc event emission. A subscriber
    // may synchronously call set()/populate(), whose handler emits again; a
    // second overlapping (or re-entrant) emit is not run concurrently. It is
    // queued in a one-slot-per-name pending map and run once the in-flight
    // chain is free, so an accepted event is never silently lost (the caller
    // already returned success) yet the emit chain can never recurse or
    // deadlock. Sequential emits (the normal path) run unaffected. Mirrors the
    // single-chain serialization style of migrationChain, without a new
    // dependency.
    let rpcEmitting = false;
    const pendingEmits = new Map<string, () => Promise<void>>();

    async function refreshAvailability(): Promise<void> {
      try {
        const res = await ctx.model.list();
        availability = new Set(
          res.data.map((model) => model.providerID + "/" + model.modelID)
        );
      } catch (err) {
        log("warn", "failed to refresh model availability snapshot", {
          error: errorText(err),
        });
      }
    }

    // Resolve parsed targets against the current snapshot + fallback map.
    // Never throws: invalid refs are dropped with a warning.
    function resolveTargets(entries: ProfileModelEntry[]): Resolution {
      const map = new Map<string, string>();
      const applied: ProfileAppliedEntry[] = [];
      const warnings: string[] = [];
      for (const entry of entries) {
        const base = entry.ref.split("#")[0];
        let finalRef = entry.ref;
        let isFallback = false;
        if (!availability.has(base)) {
          const fallback = modelFallbacks[base];
          if (fallback) {
            finalRef = fallback;
            isFallback = true;
          } else {
            warnings.push(
              "model unavailable (no fallback): " +
                base +
                ' for agent "' +
                entry.agent +
                '"; agent left unchanged'
            );
            continue;
          }
        }
        try {
          Model.Ref.parse(finalRef);
        } catch {
          warnings.push(
            'invalid model reference for agent "' +
              entry.agent +
              '": ' +
              finalRef
          );
          continue;
        }
        map.set(entry.agent, finalRef);
        applied.push({
          agent: entry.agent,
          model: finalRef,
          fallback: isFallback,
        });
      }
      return { map, applied, warnings };
    }

    // Session migration: rewrite the persisted model of every tracked session
    // (roots AND child/subagent sessions - a profile switch must move subagent
    // sessions too) whose model matches (at provider/id granularity) the
    // PREVIOUS profile target for its agent, switching it to the NEW target.
    // Never throws. Serialized via migrationChain so overlapping switches
    // cannot interleave.
    async function migrateSessions(
      name: string,
      previous: Map<string, string>,
      next: Map<string, string>
    ): Promise<void> {
      let updated = 0;
      let skippedRunning = 0;
      let skippedOffTarget = 0;
      let failed = 0;
      let stale = 0;
      for (const [sessionID, session] of tracked) {
        try {
          if (session.running) {
            skippedRunning++;
            continue;
          }
          if (!session.agent || session.model === undefined) {
            skippedOffTarget++;
            continue;
          }
          const prevRef = previous.get(session.agent);
          // Consent guard at MODEL granularity (provider/id, "#variant"
          // stripped): a session carrying a variant default (e.g. seeded by
          // the TUI as "provider/id#max") still matches the base pin and
          // migrates. An agent absent from the previous map still means
          // "leave alone" (never revert); a manual pick of a DIFFERENT model
          // is honored.
          if (
            prevRef === undefined ||
            baseModelRef(session.model) !== baseModelRef(prevRef)
          ) {
            skippedOffTarget++;
            continue;
          }
          const nextRef = next.get(session.agent);
          if (nextRef === undefined) {
            skippedOffTarget++;
            continue;
          }
          // Already at the target: no write. EXACT equality, so a variant-
          // carrying session that only matches the target's base is rewritten
          // to the full profile ref once.
          if (session.model === nextRef) continue;
          try {
            await ctx.session.switchModel({
              sessionID,
              model: Model.Ref.parse(nextRef),
            });
            // Reflect the new model immediately in the tracker instead of
            // relying solely on the async session.model.selected echo.
            session.model = nextRef;
            updated++;
          } catch (err) {
            // Stale = the session no longer exists. Confirm via a get; any
            // 404/not-found-style outcome lands in stale, not failed.
            let exists = true;
            try {
              await ctx.session.get({ sessionID });
            } catch {
              exists = false;
            }
            if (!exists) {
              stale++;
              tracked.delete(sessionID);
            } else {
              failed++;
              log("warn", "session model migration failed", {
                profile: name,
                sessionID,
                error: errorText(err),
              });
            }
          }
        } catch (err) {
          failed++;
          log("warn", "session migration entry failed", {
            profile: name,
            sessionID,
            error: errorText(err),
          });
        }
      }
      log("info", "sessions migrated", {
        profile: name,
        ...(ownDirectory ? { location: ownDirectory } : {}),
        updated,
        skippedRunning,
        skippedOffTarget,
        failed,
        stale,
      });
    }

    // Persist this instance's directory record into .active-profile (format
    // v1). Re-reads and re-parses the current file first so a concurrent write
    // by another location is not clobbered; carries the global record (fresh,
    // else the setup-time legacy value) forward; upserts this directory's
    // record (canonical when resolvable, else raw) with the new name - the
    // literal "default" is a real record, never a removal. Writes atomically
    // via a temp file + rename; deletes the file only when the projected state
    // would be empty. The caller logs any thrown write error.
    function persistActiveProfile(name: string): void {
      let rawText: string | undefined;
      try {
        rawText = readFileSync(ACTIVE_FILE, "utf8");
      } catch {
        rawText = undefined;
      }
      const parsed: ParsedActiveState =
        rawText === undefined
          ? { locations: [] }
          : parseActiveStateFile(profilesDir, rawText);
      const global = parsed.global ?? legacyGlobal;
      // Degenerate environment: no location to key on. Write an EXPLICIT v1
      // machine-wide global record (not a bare tab-less name, which the parser
      // would reinterpret as an implicit global) so bin/oc and every instance
      // still read the new active profile through the same atomic path.
      // Preserve the location records already parsed (from the fresh re-read
      // above) so this degenerate write cannot wipe other directories'
      // profiles.
      if (!ownDirectory) {
        const lines: string[] = ["global\t" + name];
        for (const record of parsed.locations) {
          lines.push("location\t" + record.directory + "\t" + record.name);
        }
        atomicWriteActive(lines.join("\n") + "\n");
        return;
      }
      const key = canonicalizeDirectory(ownDirectory);
      const locations = parsed.locations.filter(
        (record) =>
          record.directory !== key && record.directory !== ownDirectory
      );
      locations.push({ directory: key, name });
      const lines: string[] = [];
      if (global !== undefined) lines.push("global\t" + global);
      for (const record of locations) {
        lines.push("location\t" + record.directory + "\t" + record.name);
      }
      if (lines.length === 0) {
        rmSync(ACTIVE_FILE, { force: true });
        return;
      }
      atomicWriteActive(lines.join("\n") + "\n");
    }

    // Atomic state write: temp file in the same directory, then rename over
    // the target (same-directory rename is atomic on POSIX). Removes the temp
    // file if the write or rename failed.
    function atomicWriteActive(content: string): void {
      const tmp = ACTIVE_FILE + ".tmp." + process.pid + "." + Date.now();
      try {
        writeFileSync(tmp, content, "utf8");
        renameSync(tmp, ACTIVE_FILE);
      } catch (err) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // best-effort cleanup
        }
        throw err;
      }
    }

    // The full apply sequence: refresh availability, read+parse the overlay,
    // resolve, update the captured map, re-register the agent transform,
    // write .active-profile, emit "changed". Never throws.
    async function applyProfile(
      name: string,
      opts: { persist: boolean; emit: boolean; migrate?: boolean }
    ): Promise<ProfileSetResult> {
      await refreshAvailability();
      const parsed = readProfileFile(
        join(profilesDir, name, "opencode.jsonc")
      );
      const resolved = resolveTargets(parsed.entries);
      // Lazy re-capture: a launch-suppressed instance, or an earlier capture
      // that raced the config pipeline, may hold an empty base map; "default"
      // needs it to restore the main-config pins.
      if (name === "default" && baseModels.size === 0) {
        await captureBaseModels();
      }
      // Capture the map that was applied BEFORE this switch: migration only
      // touches sessions whose persisted model exactly matches it (the consent
      // guard - manual /models picks are honored).
      const previous = captured;
      captured = targetMap(name, resolved.map);
      if (
        opts.migrate &&
        previous.size > 0 &&
        !mapsEqual(previous, captured)
      ) {
        const next = captured;
        // Fire-and-forget, serialized: never awaited on the return path.
        migrationChain = migrationChain
          .then(() => migrateSessions(name, previous, next))
          .catch((err) => {
            log("warn", "session migration run failed", {
              profile: name,
              error: errorText(err),
            });
          });
      }
      let warnings = [...parsed.warnings, ...resolved.warnings];
      // The "default" profile is an identity overlay BY DESIGN: parse.ts
      // emits "<file>: no model settings found; identity applied" for it.
      // That is not a user-facing condition, so suppress only that exact
      // variant from both the warn log and the RPC result, keeping evidence
      // server-side in one info line. The other "identity applied" variants
      // ("malformed JSON (...)", "file is empty", "not a JSON object") are
      // genuine failures and stay visible.
      if (name === "default") {
        const filtered = warnings.filter(
          (warning) =>
            !warning.endsWith("no model settings found; identity applied")
        );
        if (filtered.length !== warnings.length) {
          log("info", "identity profile: parse warning suppressed", {
            profile: name,
            count: warnings.length - filtered.length,
          });
          warnings = filtered;
        }
      }
      for (const warning of warnings) {
        log("warn", warning, { profile: name });
      }
      try {
        // Re-register so our transform is last in the shared editor pipeline
        // (see registerAgentTransform). Registration invalidates the agent
        // state, and the registry rebuilds - replaying every transform onto a
        // fresh base value - on the next read, so no explicit reload() is
        // needed; calling it would only repeat that rebuild.
        await registerAgentTransform();
      } catch (err) {
        log("warn", "agent transform registration failed", {
          error: errorText(err),
        });
      }
      activeName = name;
      if (opts.persist) {
        try {
          persistActiveProfile(name);
        } catch (err) {
          log("warn", "failed to write .active-profile", {
            error: errorText(err),
          });
        }
      }
      if (opts.emit && emitChanged) {
        try {
          await emitChanged(name);
        } catch (err) {
          log("warn", "failed to emit changed event", {
            error: errorText(err),
          });
        }
      }
      log("info", "profile applied", {
        active: name,
        applied: resolved.applied.length,
        warnings: warnings.length,
        persist: opts.persist,
      });
      return {
        active: name,
        applied: resolved.applied,
        warnings,
      };
    }

    // Same-location convergence: the agent registry is per LOCATION, and an
    // rpc set() reaches only the instance serving the caller's location, but
    // every instance subscribes to this plugin's "changed" event. A broadcast
    // from a DIFFERENT directory is ignored (see the event loop); an instance
    // whose location matches the switch re-applies it locally so its own
    // registry converges. Never emits (no loop) and never persists (the
    // setter already wrote the state file).
    async function convergeTo(next: string): Promise<void> {
      try {
        await refreshAvailability();
        const parsed = readProfileFile(
          join(profilesDir, next, "opencode.jsonc")
        );
        const resolved = resolveTargets(parsed.entries);
        if (
          next === activeName &&
          mapsEqual(targetMap(next, resolved.map), captured)
        ) {
          return;
        }
        launchSuppressed = false;
        await applyProfile(next, { persist: false, emit: false, migrate: true });
        log("info", "converged to active profile from another instance", {
          active: next,
        });
      } catch (err) {
        log("warn", "convergence apply failed", {
          profile: next,
          error: errorText(err),
        });
      }
    }

    // Provider/model event re-evaluation: refresh the snapshot, re-resolve
    // the active profile, and re-run the full apply ONLY when the re-resolved
    // outcome differs from what is currently applied.
    async function reevaluate(): Promise<void> {
      if (cleanedUp || launchSuppressed) return;
      try {
        await refreshAvailability();
        const parsed = readProfileFile(
          join(profilesDir, activeName, "opencode.jsonc")
        );
        const resolved = resolveTargets(parsed.entries);
        if (mapsEqual(targetMap(activeName, resolved.map), captured)) {
          log(
            "info",
            "provider/model change: re-resolved outcome unchanged; skipping",
            { active: activeName }
          );
          return;
        }
        log("info", "provider/model change: re-applying profile", {
          active: activeName,
        });
        await applyProfile(activeName, { persist: true, emit: true, migrate: true });
      } catch (err) {
        log("warn", "re-evaluation failed", { error: errorText(err) });
      }
    }

    // ---- agent transform registration ----------------------------------
    // Transforms run in registration order over a shared editor. The core
    // config-agent plugin registers its own model transform only AFTER
    // plugin setup (it awaits its config documents), so a transform
    // registered once here would run before it and be overwritten by it.
    // applyProfile() therefore disposes the previous registration and
    // registers a fresh one: Set re-insertion appends it, so the newest
    // (profile) transform always runs last and wins.
    let agentRegistration: { dispose: () => Promise<void> } | undefined;

    async function registerAgentTransform(): Promise<void> {
      if (agentRegistration) {
        try {
          await agentRegistration.dispose();
        } catch (err) {
          log("warn", "failed to dispose previous agent transform", {
            error: errorText(err),
          });
        }
        agentRegistration = undefined;
      }
      agentRegistration = await ctx.agent.transform((editor) => {
        for (const [agent, ref] of captured) {
          if (!editor.get(agent)) continue;
          try {
            const parsed = Model.Ref.parse(ref);
            editor.update(agent, (info) => {
              info.model = parsed;
            });
          } catch (err) {
            // refs are validated at resolve time; never break the transform
            log("warn", "transform skipped an entry", {
              agent,
              error: errorText(err),
            });
          }
        }
      });
    }

    // ---- base model capture --------------------------------------------
    // Always captured, even for launch-suppressed instances: an in-session
    // set("default") on such an instance must be able to restore the
    // main-config pins.
    await captureBaseModels();

    // ---- initial application (never persists, never emits) -------------
    if (!launchSuppressed) {
      await applyProfile(activeName, { persist: false, emit: false });
      // The core config-agent transform registers only after plugin setup, so
      // a profile active at startup would be overwritten until the pipeline
      // settles. One idempotent re-register afterward keeps ours last.
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (cleanedUp || captured.size === 0) return;
        void (async () => {
          try {
            await registerAgentTransform();
            log("info", "settle re-apply after config pipeline", {
              active: activeName,
            });
          } catch (err) {
            log("warn", "settle re-apply failed", { error: errorText(err) });
          }
        })();
      }, SETTLE_DELAY_MS);
    }

    // ---- rpc registration ----------------------------------------------
    const rpcRegistration = await ctx.rpc.register(Profile, {
      list: async () => {
        const profiles: ProfileListEntry[] = [];
        try {
          for (const dirent of readdirSync(profilesDir, { withFileTypes: true })) {
            if (!dirent.isDirectory()) continue;
            const file = join(profilesDir, dirent.name, "opencode.jsonc");
            if (existsSync(file)) {
              profiles.push({ name: dirent.name, file });
            }
          }
        } catch (err) {
          log("warn", "failed to list profiles", { error: errorText(err) });
        }
        profiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { active: activeName, profiles };
      },
      current: async () => ({
        active: activeName,
        agents: currentAgentModels(),
      }),
      set: async (input, context) => {
        const name = (input as { name?: unknown } | undefined)?.name;
        if (typeof name !== "string" || !isSafeProfileName(name)) {
          return context.error(
            "unknown_profile",
            "invalid profile name: " + String(name),
            { name: String(name) }
          );
        }
        if (!existsSync(join(profilesDir, name, "opencode.jsonc"))) {
          return context.error(
            "unknown_profile",
            "unknown profile: " + name,
            { name }
          );
        }
        const result = await applyProfile(name, { persist: true, emit: true, migrate: true });
        // runtimeActive now came from this set, not from launch detection.
        launchSuppressed = false;
        return result;
      },
      populate: async (input) => {
        const populateInput = input as ProfilePopulateInput | undefined;
        const sessions: ProfilePopulateSession[] =
          populateInput?.sessions ?? [];
        // Explicit top-level claim-refresh target (Fix 1). Validated like a
        // per-entry window id; absent/invalid -> legacy per-entry-only
        // semantics. `location` (also top-level, as the TUI cleanup sends it)
        // routes an entry-less refresh to the owning instance; absent ->
        // lenient (every instance applies).
        const rawWindow = populateInput?.window;
        const inputWindow = isWindowId(rawWindow) ? rawWindow : undefined;
        const rawLocation = populateInput?.location;
        const inputLocation =
          typeof rawLocation === "string" && rawLocation ? rawLocation : undefined;
        // Validate/resolve each entry into a CLEAN entry that always carries a
        // non-empty string location. Entries that cannot be resolved to one
        // are skipped here and never dispatched.
        const clean: ProfilePopulateSession[] = [];
        let skipped = 0;
        for (const entry of sessions) {
          try {
            if (!entry || typeof entry.sessionID !== "string") {
              skipped++;
              continue;
            }
            const sessionID = entry.sessionID;
            // The claiming window id (validated). Absent/invalid -> legacy
            // payload: seeded but never claimed, so it is never pruned.
            const window = isWindowId(entry.window) ? entry.window : undefined;
            let location: string | undefined;
            let agent: string | undefined;
            let model: string | undefined;
            let parentID: string | undefined;
            if (typeof entry.location === "string" && entry.location) {
              // The TUI enumerated this session from its own location's
              // directory-filtered list: the location is authoritative and no
              // session.get round-trip is needed. Model is already a
              // normalized ref string.
              location = entry.location;
              agent = typeof entry.agent === "string" ? entry.agent : undefined;
              model = typeof entry.model === "string" ? entry.model : undefined;
              parentID =
                typeof entry.parentID === "string"
                  ? entry.parentID
                  : undefined;
            } else {
              // Tabs-gap entry without a location: ONE session.get resolves
              // the authoritative owner directory. A failed get skips the
              // entry entirely (never seeded from unverified fields).
              let info:
                | {
                    agent?: unknown;
                    model?: unknown;
                    parentID?: unknown;
                    location?: { directory?: unknown };
                    time?: { archived?: unknown };
                  }
                | undefined;
              try {
                info = await ctx.session.get({ sessionID });
              } catch {
                info = undefined;
              }
              if (!info) {
                skipped++;
                continue;
              }
              if (info.time?.archived !== undefined) {
                skipped++;
                continue;
              }
              location =
                typeof info.location?.directory === "string"
                  ? info.location.directory
                  : undefined;
              agent = typeof info.agent === "string" ? info.agent : undefined;
              model = normalizeModelRef(
                info.model as
                  | { providerID?: unknown; id?: unknown; variant?: unknown }
                  | null
                  | undefined
              );
              parentID =
                typeof info.parentID === "string" ? info.parentID : undefined;
            }
            if (typeof location !== "string" || !location) {
              skipped++;
              continue;
            }
            clean.push({
              sessionID,
              ...(agent !== undefined ? { agent } : {}),
              ...(model !== undefined ? { model } : {}),
              ...(parentID !== undefined ? { parentID } : {}),
              location,
              ...(window !== undefined ? { window } : {}),
            });
          } catch (err) {
            log("warn", "populate entry failed", {
              error: errorText(err),
            });
          }
        }
        // Broadcast the clean entries through this plugin's own rpc event so
        // EVERY instance receives them (a module-scope registry cannot span
        // instances: each gets an isolated module copy). Each instance seeds
        // only the entries whose location equals its own directory. A
        // validated top-level window (and its routing location, when given) is
        // forwarded too, so an empty `sessions` array still requests an
        // explicit claim replacement for that window.
        try {
          await guardedEmit("populate", () =>
            rpcRegistration.events.emit("populate", {
              sessions: clean,
              ...(inputWindow !== undefined ? { window: inputWindow } : {}),
              ...(inputLocation !== undefined
                ? { location: inputLocation }
                : {}),
            })
          );
        } catch (err) {
          log("warn", "failed to emit populate event", {
            error: errorText(err),
          });
        }
        log("info", "populate dispatched", {
          requested: sessions.length,
          dispatched: clean.length,
          skipped,
          ...(inputWindow !== undefined ? { refreshWindow: inputWindow } : {}),
        });
        // The TUI ignores this value. `tracked` now means "dispatched": the
        // emitter cannot know how many instances actually seeded.
        return { tracked: clean.length };
      },
    });

    // Run one rpc event emit under the shared serialization guard above. A
    // re-entrant/concurrent emit is queued (latest thunk per event name) rather
    // than discarded: once the in-flight emit settles, the queued thunks run in
    // turn, so an event whose callers already returned success is not lost.
    // At most one extra emit per name is ever queued; a re-queue during the
    // drain waits for the next free call so the chain cannot spin. Queued
    // failures are logged (no caller remains); the in-flight thunk's failure
    // still propagates to its caller. Never deadlocks: rpcEmitting is cleared
    // in a finally before any queued thunk runs.
    async function guardedEmit(
      eventName: string,
      emit: () => Promise<void>
    ): Promise<void> {
      if (rpcEmitting) {
        pendingEmits.set(eventName, emit);
        log("info", "rpc emit queued: another emit is in flight", {
          event: eventName,
          queued: pendingEmits.size,
        });
        return;
      }
      rpcEmitting = true;
      let failure: unknown;
      let failed = false;
      try {
        await emit();
      } catch (err) {
        failure = err;
        failed = true;
      } finally {
        rpcEmitting = false;
      }
      // Chain free: run the queued emits (latest thunk per name). Snapshot and
      // clear first so a re-entrant queue during the drain waits for the next
      // free call instead of looping.
      const queued = Array.from(pendingEmits.entries());
      pendingEmits.clear();
      for (const [name, thunk] of queued) {
        rpcEmitting = true;
        try {
          await thunk();
        } catch (err) {
          log("warn", "queued rpc emit failed", {
            event: name,
            error: errorText(err),
          });
        } finally {
          rpcEmitting = false;
        }
      }
      if (failed) throw failure;
    }

    emitChanged = async (active: string) => {
      await guardedEmit("changed", () =>
        rpcRegistration.events.emit("changed", {
          active,
          agents: currentAgentModels(),
        })
      );
    };
    disposeRpc = () => rpcRegistration.dispose();

    // ---- provider/model event subscription (debounced) -----------------
    const controller = new AbortController();
    const eventStream = ctx.event.subscribe({ signal: controller.signal });
    (async () => {
      try {
        for await (const event of eventStream) {
          if (!event) continue;
          // Same-location convergence: the agent registry is per LOCATION and
          // an rpc set() reaches only the serving instance, so re-apply the
          // broadcast profile locally (see convergeTo). A broadcast from
          // ANOTHER directory must not converge here - it would re-migrate
          // this location's sessions for a foreign profile. Lenient like
          // locationMismatch: no location on either side -> accept.
          if (event.type === "rpc.profile.changed") {
            const data = (event as { data?: { active?: unknown } }).data;
            const next =
              typeof data?.active === "string" ? data.active : undefined;
            if (
              next &&
              isSafeProfileName(next) &&
              !cleanedUp &&
              !locationMismatch(eventLocationDirectory(event))
            ) {
              void convergeTo(next);
            }
            continue;
          }
          // Cross-instance seeding: the populate RPC cannot reach the tracker of
          // a foreign instance through a module-scope registry (each instance
          // gets an isolated module copy), so the handler broadcasts clean
          // entries through this plugin's own rpc event. Every instance
          // (including the emitter) lands here and seeds ONLY the entries whose
          // location is its own directory; valid window ids additionally claim
          // the session for that window. Never re-emitted. Handled here so the
          // event never reaches the provider/model re-evaluation path below.
          if (event.type === "rpc.profile.populate") {
            const data = (
              event as {
                data?: {
                  sessions?: unknown;
                  window?: unknown;
                  location?: unknown;
                };
              }
            ).data;
            const entries: unknown[] = Array.isArray(data?.sessions)
              ? data.sessions
              : [];
            // Explicit top-level window refresh (Fix 1): `sessions: []` with a
            // top-level `window` still requests a claim replacement for that
            // window. The optional top-level `location` routes it to the owning
            // instance (lenient when absent, like locationMismatch).
            const topWindow = isWindowId(data?.window) ? data.window : undefined;
            const rawTopLocation = data?.location;
            const topLocation =
              typeof rawTopLocation === "string" && rawTopLocation
                ? rawTopLocation
                : undefined;
            const topWindowTargetsThisInstance =
              topWindow !== undefined &&
              !(
                ownDirectory !== undefined &&
                topLocation !== undefined &&
                topLocation !== ownDirectory
              );
            let seeded = 0;
            let claimed = 0;
            // Per-window claim groups CONSOLIDATED from THIS payload before any
            // application (Fix 3): a window's set is built once from all of its
            // entries, and applied below by straight replacement, so a payload
            // is authoritative and never unions with the accumulated claims.
            const nextClaims = new Map<string, Set<string>>();
            for (const raw of entries) {
              const entry = raw as
                | {
                    sessionID?: unknown;
                    agent?: unknown;
                    model?: unknown;
                    parentID?: unknown;
                    location?: unknown;
                    window?: unknown;
                  }
                | undefined;
              if (!entry || typeof entry.sessionID !== "string") continue;
              if (
                typeof ownDirectory !== "string" ||
                entry.location !== ownDirectory
              ) {
                // Another location's session: its own instance seeds it.
                continue;
              }
              const window = isWindowId(entry.window) ? entry.window : undefined;
              if (
                seedSession(
                  {
                    sessionID: entry.sessionID,
                    agent:
                      typeof entry.agent === "string" ? entry.agent : undefined,
                    model:
                      typeof entry.model === "string" ? entry.model : undefined,
                    parentID:
                      typeof entry.parentID === "string"
                        ? entry.parentID
                        : undefined,
                  },
                  window !== undefined
                )
              ) {
                seeded++;
              }
              if (window !== undefined) {
                let ids = nextClaims.get(window);
                if (!ids) {
                  ids = new Set<string>();
                  nextClaims.set(window, ids);
                }
                ids.add(entry.sessionID);
                claimed++;
              }
            }
            // Materialize an explicit top-level window even with ZERO entries:
            // for a targeting instance an empty set is a valid authoritative
            // replacement that prunes the window's formerly claimed sessions.
            if (topWindow !== undefined && topWindowTargetsThisInstance) {
              if (!nextClaims.has(topWindow)) {
                nextClaims.set(topWindow, new Set<string>());
              }
            }
            // Apply per payload: each window named by THIS payload REPLACES its
            // accumulated claim set outright (no union across payloads), so a
            // single sender ends at its latest payload's set and the last
            // payload to name a window wins. Windows this payload does not name
            // are untouched, so one window's replacement never drops another's
            // claims. Then drop tracked entries no longer covered by ANY current
            // claim set. Never-claimed entries (session.created only, or legacy
            // no-window payloads) stay.
            for (const [window, ids] of nextClaims) {
              claims.set(window, ids);
            }
            if (nextClaims.size > 0) pruneReleasedClaims();
            if (entries.length > 0 || topWindow !== undefined) {
              log("info", "populate seeded", {
                received: entries.length,
                seeded,
                claimed,
                windows: nextClaims.size,
                ...(topWindow !== undefined
                  ? {
                      refreshWindow: topWindow,
                      refreshApplied: topWindowTargetsThisInstance,
                    }
                  : {}),
                ...(ownDirectory ? { location: ownDirectory } : {}),
              });
            }
            continue;
          }
          // Session tracker: session.created / agent.selected / model.selected /
          // deleted / execution.* keep the per-session model map current.
          if (handleSessionEvent(event)) continue;
          if (
            event.type !== "provider.updated" &&
            event.type !== "model.updated"
          ) {
            continue;
          }
          if (cleanedUp) break;
          if (reevalTimer) clearTimeout(reevalTimer);
          reevalTimer = setTimeout(() => {
            reevalTimer = undefined;
            void reevaluate();
          }, REEVAL_DEBOUNCE_MS);
        }
      } catch (err) {
        if (!cleanedUp) {
          log("warn", "event stream ended", { error: errorText(err) });
        }
      }
    })();

    // ---- cleanup (always safe, idempotent) -----------------------------
    return async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (reevalTimer) {
        clearTimeout(reevalTimer);
        reevalTimer = undefined;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      try {
        controller.abort();
      } catch {
        // best-effort only
      }
      if (agentRegistration) {
        try {
          await agentRegistration.dispose();
        } catch (err) {
          log("warn", "failed to dispose agent transform", {
            error: errorText(err),
          });
        }
        agentRegistration = undefined;
      }
      if (disposeRpc) {
        try {
          await disposeRpc();
        } catch (err) {
          log("warn", "failed to dispose rpc registration", {
            error: errorText(err),
          });
        }
      }
      log("info", "cleanup: plugin unloaded", { active: activeName });
    };
  },
});

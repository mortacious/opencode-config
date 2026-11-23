// subagent-cap internals: option normalization, launched-profile detection,
// effective-cap resolution, and the running-child accounting that
// lib/transform.js drives.
//
// Counter scope: the running set below is per plugin server instance, not
// machine-wide. Subagent spawns issued from another OpenCode window (another
// server instance) are invisible here and therefore bypass this cap.
//
// Liveness: @opencode/schema Session.Info has no boolean "running" flag; a
// child counts as finished when its time.idle stamp is set. Reconciliation is
// pull-based (only on a blocked spawn attempt) - no timers, no event
// subscriptions, no permit tokens.

import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// lib/ lives at <config>/plugin-src/subagent-cap/lib, so three levels up is
// the config dir bin/oc launches from (same CONFIG_DIR that
// profile-switcher derives from its own plugin dir).
const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const DEFAULT_TOOL_IDS = ["subagent", "task"];

function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

// Fail-open warnings already emitted, keyed by the degenerate option value. A
// present-but-unusable key silently degrades to unlimited, so each distinct
// value is surfaced once per process instead of staying invisible; repeated
// setups with the same bad value stay quiet.
const warnedDegenerate = new Set();

function warnDegenerate(logger, signature, message) {
  if (warnedDegenerate.has(signature)) return;
  warnedDegenerate.add(signature);
  if (logger && typeof logger.warn === "function") logger.warn(message);
}

// ctx.options -> {max, profiles, toolIds} with defaults applied. max === 0
// means unlimited. Non-numeric/negative caps degrade to 0 (unlimited) rather
// than silently capping at an unexpected value, but each such degradation is
// warned about once. An explicit numeric {max: 0} is intentional and silent.
export function normalizeOptions(raw, logger = console) {
  const src = raw && typeof raw === "object" ? raw : {};
  const profiles = {};
  if (src.profiles && typeof src.profiles === "object") {
    for (const [name, value] of Object.entries(src.profiles)) {
      const cap = positiveInt(value);
      if (cap > 0) {
        profiles[name] = cap;
      } else {
        warnDegenerate(
          logger,
          "profiles." + name + "=" + JSON.stringify(value),
          "[subagent-cap] WARNING: option profiles[" +
            JSON.stringify(name) +
            "]=" +
            JSON.stringify(value) +
            " normalizes to unlimited (only positive numbers cap) - that profile is NOT capped."
        );
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(src, "profiles")) {
    warnDegenerate(
      logger,
      "profiles=" + typeof src.profiles,
      "[subagent-cap] WARNING: option profiles is not an object (" +
        typeof src.profiles +
        ") - no profile is capped and the cap falls back to max."
    );
  }
  const toolIds =
    Array.isArray(src.toolIds) && src.toolIds.length > 0
      ? src.toolIds.filter((id) => typeof id === "string" && id.length > 0)
      : DEFAULT_TOOL_IDS.slice();
  let max = 0;
  if (Object.prototype.hasOwnProperty.call(src, "max")) {
    max = positiveInt(src.max);
    // src.max === 0 is explicit unlimited and stays silent; anything else that
    // normalizes to 0 is a typo/unsupported value worth surfacing.
    if (max === 0 && src.max !== 0) {
      warnDegenerate(
        logger,
        "max=" + JSON.stringify(src.max),
        "[subagent-cap] WARNING: option max=" +
          JSON.stringify(src.max) +
          " is not a positive number (0 means unlimited) - the cap is NOT enforced. Fix the value or remove the key."
      );
    }
  }
  return {
    max,
    profiles,
    toolIds: toolIds.length > 0 ? toolIds : DEFAULT_TOOL_IDS.slice(),
  };
}

function expandTilde(target) {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  return target;
}

function isSafeProfileName(name) {
  if (!name) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes(sep)) return false;
  return true;
}

// Launched-profile detection, mirroring profile-switcher's
// detectLaunchedProfile: bin/oc exports
// OPENCODE_CONFIG=<CONFIG_DIR>/profiles/<name>/opencode.jsonc.
export function detectLaunchedProfile() {
  const raw = process.env.OPENCODE_CONFIG;
  if (!raw) return undefined;
  let target;
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

// profiles[detectedProfile] wins over max. 0 (or an unknown/absent profile
// with max 0) means no cap.
export function resolveEffectiveCap(opts, profile) {
  const profiles = opts && opts.profiles ? opts.profiles : {};
  if (typeof profile === "string" && Object.prototype.hasOwnProperty.call(profiles, profile)) {
    return profiles[profile];
  }
  return opts && typeof opts.max === "number" ? opts.max : 0;
}

// The profile label that reaches the calling agent in the block message.
// Base sessions (no profile overlay) are reported as "base".
export function profileLabel(profile) {
  return typeof profile === "string" && profile ? profile : "base";
}

export function blockMessage(running, cap, profile) {
  return (
    "subagent cap reached: " +
    running +
    "/" +
    cap +
    ' running under profile "' +
    profileLabel(profile) +
    '" - this delegation was blocked. Wait for running subagents to finish, ' +
    "then retry (completed subagents free capacity automatically)."
  );
}

// Best-effort extraction of the child session id from a subagent tool result:
// the spawn's output/metadata carries it in some shape on this build, and the
// exact field name is unverified. Returns undefined when nothing looks like a
// session id.
export function extractSessionID(result) {
  if (!result || typeof result !== "object") return undefined;
  const looksLikeSession = (value) =>
    typeof value === "string" && value.length > 0 && /^ses[_-]?[A-Za-z0-9_-]+$/.test(value)
      ? value
      : undefined;
  const fromObject = (value) => {
    if (!value || typeof value !== "object") return undefined;
    for (const key of ["sessionID", "sessionId", "session", "childSessionID", "id"]) {
      const direct = looksLikeSession(value[key]);
      if (direct) return direct;
      if (key === "session" && value[key] && typeof value[key] === "object") {
        const nested = looksLikeSession(value[key].id);
        if (nested) return nested;
      }
    }
    return undefined;
  };
  const direct = fromObject(result.output);
  if (direct) return direct;
  const meta = fromObject(result.metadata);
  if (meta) return meta;
  if (typeof result.content === "string") {
    const match = result.content.match(/ses[_-]?[A-Za-z0-9_-]{5,}/);
    if (match) return match[0];
  }
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        const match = part.text.match(/ses[_-]?[A-Za-z0-9_-]{5,}/);
        if (match) return match[0];
      }
    }
  }
  return undefined;
}

// createCapState: the accounting core.
// - tryAcquire() increments synchronously (returns a record or null when at cap)
// - reconcile() releases tracked children whose time.idle is set
// - release(record) drops the record after a failed/settled foreground call
// - settle(record, result) keeps a still-running background child tracked
export function createCapState({ cap, profile, getSession }) {
  const running = new Set();

  function tryAcquire() {
    if (!(cap > 0) || running.size >= cap) return null;
    const record = { sessionID: null };
    running.add(record);
    return record;
  }

  async function isIdle(sessionID) {
    if (typeof sessionID !== "string" || !sessionID) return undefined;
    if (typeof getSession !== "function") return undefined;
    let info;
    try {
      info = await getSession(sessionID);
    } catch {
      return undefined;
    }
    if (!info) return true; // session vanished -> capacity is free
    return Boolean(info.time && info.time.idle !== undefined && info.time.idle !== null);
  }

  async function reconcile() {
    const tracked = Array.from(running).filter((record) => record.sessionID);
    for (const record of tracked) {
      const idle = await isIdle(record.sessionID);
      if (idle === true) running.delete(record);
    }
    return running.size;
  }

  function release(record) {
    running.delete(record);
  }

  async function settle(record, result, callerSessionID) {
    const sessionID = extractSessionID(result);
    if (!sessionID || sessionID === callerSessionID) {
      // No child id to track, or the result pointed back at the calling
      // session: free the slot.
      running.delete(record);
      return;
    }
    record.sessionID = sessionID;
    const idle = await isIdle(sessionID);
    if (idle !== false) {
      // Foreground flow (idle already stamped or unknowable): free the slot.
      running.delete(record);
    }
    // idle === false: the child is still running (background delegation);
    // keep it tracked so a later blocked attempt can reconcile it.
  }

  return {
    cap,
    profile: profileLabel(profile),
    tryAcquire,
    reconcile,
    release,
    settle,
    count: () => running.size,
    // Test/debug view of the tracked session ids.
    trackedIDs: () => Array.from(running, (record) => record.sessionID).filter(Boolean),
    blockMessage: () => blockMessage(running.size, cap, profile),
  };
}

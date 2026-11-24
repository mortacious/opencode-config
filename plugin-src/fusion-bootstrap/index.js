// fusion-bootstrap: session-start skill reminders for the Fusion tree.
//
// Failure this plugin addresses: a primary session delegates, or a delegated
// session starts, without loading the skills the work needs - and nothing in
// the transcript ever shows that the load was skipped. Short reminders are
// injected as an extra system part on every primary model request (the seam
// opencode's own plugins use: ctx.session.hook("context", ...) receives the
// mutable SessionContext, and pushing onto input.system adds an instruction
// without writing a transcript message, so nothing accumulates):
//
// - Primary sessions (any agent whose resolved info reports mode "primary")
//   that the ACTIVE profile's tiers.json lists in its agents mapping: check the
//   skill catalog before acting; delegations load the fusion-delegation-spec
//   skill and fill a dispatch template from its templates/ directory instead of
//   a freehand task spec. When the profile carries tiers.json, a compact
//   model-tier table is appended to the same part so the primary can pick a
//   tier and pass its literal model id on the subagent call. A primary the
//   mapping does not list (a project that ships its own agents) gets the tier
//   table and the permission brief only, never the Fusion reminder. No roster
//   list lives here: the mode comes from agent info and the mapping from the
//   profile, so a new agents/<name>.md is picked up as-is.
// - Child sessions (any session with a structural parentID): the task prompt
//   is the full specification, load the skills it names, and the report MUST
//   begin with the "SKILLS:" line so a skipped load is visible. Every
//   delegated specialist runs here, whatever its name.
// - Every session (primary and child): a compact permission brief built from
//   the session agent's own permissions array (ctx.agent.get), because opencode
//   never tells an agent which rules it carries. FindLast rules are summarized
//   as a mode ("edit: deny", "shell: deny by default; allowed: git, cat, ...")
//   so an agent knows its boundaries before tripping them. Computed once per
//   agent name, fail-soft: no agent info means no brief.
//
// Parent detection is structural (ctx.session.get -> Info.parentID), never a
// tag parsed out of the prompt: obra/superpowers skips child sessions the
// same way. Only parentage is cached, because only parentage is immutable per
// session; a failed lookup injects nothing and is retried on the next request
// rather than guessed.
//
// The session directory and the active profile are read fresh on every primary
// context call, so a session_move or an in-session profile switch is picked up
// on the next request. The profile follows the shared resolver
// (plugin-src/shared/active-profile.js): the launched overlay wins, then
// OC_PROFILE, then that directory's location record in <config>/.active-profile,
// then the last global record, then "default"; a candidate naming a profile
// without profiles/<name>/tiers.json (the file this consumer needs) is skipped
// as stale. Tier loading is fail-soft: a missing or invalid tiers.json simply
// omits the block and never throws into the request. A tier whose authored
// model is empty is rendered as "unavailable" and the primary is told not to
// route work that needs it to any model.

import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Plugin } from "@opencode/plugin";

import { resolveProfile } from "../shared/active-profile.js";

const MARKER = "fusion-bootstrap";

// index.js lives at <config>/plugin-src/fusion-bootstrap/index.js, so two
// levels up is the config dir a launched overlay (OPENCODE_CONFIG=...) starts
// from (the same CONFIG_DIR that subagent-cap derives from its lib/
// directory).
const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PRIMARY_REMINDER = [
  "Fusion bootstrap:",
  "- At session start, load the fusion-workflow skill for the workflow map.",
  "- Before acting, check the skill catalog.",
  "- When delegating, load the fusion-delegation-spec skill and fill a dispatch template from its templates/ directory; never freehand a task spec.",
  "- Economize: delegate reads and bulk output; ask for condensed reports; prune closed blocks at step close.",
].join("\n");

const CHILD_REMINDER = [
  "Fusion bootstrap:",
  "Your task prompt is your full specification. Load the skills it names before starting.",
  "Your report MUST begin with a line: SKILLS: <comma-separated ids of skills you loaded, or none>",
].join("\n");

function isSafeProfileName(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

// The tier-table consumer needs profiles/<name>/tiers.json: a candidate naming
// a profile without it is stale (deleted, renamed, or overlay-only) and is
// skipped rather than shadowing the next candidate. bin/opencode-profile and
// the profile-switcher apply the equivalent check for the overlay they
// consume.
function profileHasTiers(configDir, name) {
  if (!isSafeProfileName(name)) return false;
  try {
    return fs.statSync(join(configDir, "profiles", name, "tiers.json")).isFile();
  } catch {
    return false;
  }
}

// The profile whose tiers apply to this call, resolved by the shared resolver
// with this consumer's usability rule (profiles/<name>/tiers.json exists).
export function resolveActiveProfile(
  env = process.env,
  configDir = CONFIG_DIR,
  directory = "",
) {
  return resolveProfile({
    env,
    configDir,
    directory,
    profileExists: (name) => profileHasTiers(configDir, name),
  });
}

// Reads profiles/<name>/tiers.json fresh. Returns ordered rows
// [{name, model, description}] plus the agent->tier mapping, or null on any
// miss (absent file, bad JSON, unexpected shape) - never throws. An empty
// model is allowed and means the tier is unavailable in this profile, unless
// an agent maps to it (defensive: the generator and validator reject that).
export function loadTierTable(configDir, profile) {
  if (!isSafeProfileName(profile)) return null;
  let data;
  try {
    data = JSON.parse(
      fs.readFileSync(join(configDir, "profiles", profile, "tiers.json"), "utf8"),
    );
  } catch {
    return null;
  }
  const tiers = data && typeof data === "object" ? data.tiers : null;
  const agents = data && typeof data === "object" ? data.agents : null;
  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) return null;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return null;
  const entries = [];
  const models = new Map();
  for (const name of Object.keys(tiers)) {
    const entry = tiers[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (typeof entry.model !== "string") return null;
    if (typeof entry.description !== "string") return null;
    const model = entry.model.trim();
    const description = entry.description.trim();
    if (description === "") return null;
    if (/[\r\n]/.test(entry.description)) return null;
    entries.push({ name, model, description });
    models.set(name, model);
  }
  if (entries.length === 0) return null;
  const mapping = {};
  for (const name of Object.keys(agents)) {
    const tier = agents[name];
    if (typeof tier !== "string" || !models.has(tier)) return null;
    if (models.get(tier) === "") return null;
    mapping[name] = tier;
  }
  if (Object.keys(mapping).length === 0) return null;
  return { profile, entries, mapping };
}

// Compact appended block: every authored tier with its model and description,
// every agent's default tier, and the delegation policy. An empty model renders
// as "unavailable" with one sentence telling the primary not to route work
// there. Kept short because it rides every request.
export function formatTierTable(table) {
  if (!table) return "";
  const lines = [
    'Model tiers (profile "' + table.profile + '", authored in profiles/' + table.profile + "/tiers.json):",
  ];
  let unavailable = false;
  for (const entry of table.entries) {
    if (entry.model === "") unavailable = true;
    const model = entry.model === "" ? "unavailable" : entry.model;
    lines.push("- " + entry.name + ": " + model + " - " + entry.description);
  }
  const defaults = Object.keys(table.mapping)
    .sort()
    .map((name) => name + "=" + table.mapping[name])
    .join(", ");
  lines.push("- Agent defaults: " + defaults);
  if (unavailable) {
    lines.push(
      "A tier marked unavailable has no model in this profile; do not route work " +
        "that needs it to any model, and tell the user it is unavailable.",
    );
  }
  lines.push(
    "Policy: choose the tier whose description matches the work, default to the " +
      "delegating agent's tier; to override, pass that tier's model id as the " +
      "subagent tool's model parameter.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Permission brief.
//
// Opencode never tells an agent which permission rules it carries, so an agent
// learns its boundaries only by tripping them - a deny costs a turn, an ask
// costs the user a prompt. This block summarizes the session agent's own
// permissions array into one compact system part, using findLast semantics:
// the last rule matching an action and resource wins, so a later deny beats an
// earlier blanket allow (and a later re-allow beats that deny).
//
// Only blanket rules (resource "*") decide an action's mode; the rules after
// that blanket rule are summarized as counts or as the allowed families.

const MAX_BRIEF = 500;
const MAX_FAMILIES = 12;
const MAX_LABEL = 24;

// The last rule for one action whose resource is the widest ("*"). effect is
// null when the agent declares no blanket rule for that action.
function lastBlanket(rules, action) {
  let effect = null;
  let index = -1;
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (!rule || rule.action !== action || rule.resource !== "*") continue;
    if (typeof rule.effect === "string") {
      effect = rule.effect;
      index = i;
    }
  }
  return { effect, index };
}

function familyLabel(resource) {
  const base =
    typeof resource === "string" ? resource.replace(/\*+$/, "").trim() : "";
  if (!base || base === "*") return "*";
  return base.length > MAX_LABEL ? base.slice(0, MAX_LABEL) + "..." : base;
}

function shellText(rules, blanket, compact) {
  if (blanket.effect === "deny") {
    let denied = 0;
    const seen = new Set();
    const families = [];
    for (let i = blanket.index + 1; i < rules.length; i += 1) {
      const rule = rules[i];
      if (!rule || rule.action !== "shell") continue;
      if (rule.effect === "deny") {
        denied += 1;
        continue;
      }
      if (rule.effect !== "allow") continue;
      const label = familyLabel(rule.resource);
      if (seen.has(label)) continue;
      seen.add(label);
      families.push(label);
    }
    if (compact || families.length === 0) {
      return (
        "deny by default with " + denied + " deny rule" + (denied === 1 ? "" : "s")
      );
    }
    const extra = families.length - MAX_FAMILIES;
    return (
      "deny by default; allowed: " +
      families.slice(0, MAX_FAMILIES).join(", ") +
      (extra > 0 ? " (+" + extra + " more)" : "")
    );
  }
  if (blanket.effect === "allow") {
    let denied = 0;
    for (let i = blanket.index + 1; i < rules.length; i += 1) {
      const rule = rules[i];
      if (rule && rule.action === "shell" && rule.effect === "deny") denied += 1;
    }
    return (
      "allow by default with " + denied + " deny rule" + (denied === 1 ? "" : "s")
    );
  }
  if (blanket.effect === "ask") return "ask by default";
  return "unset (profile default)";
}

function subagentText(rules, blanket) {
  if (blanket.effect === "deny") {
    const names = [];
    for (let i = blanket.index + 1; i < rules.length; i += 1) {
      const rule = rules[i];
      if (!rule || rule.action !== "subagent" || rule.effect !== "allow") continue;
      if (typeof rule.resource === "string" && rule.resource !== "*") {
        names.push(rule.resource);
      }
    }
    return names.length ? "deny (allowed: " + names.join(", ") + ")" : "deny";
  }
  if (blanket.effect === "allow") {
    let denied = 0;
    for (let i = blanket.index + 1; i < rules.length; i += 1) {
      const rule = rules[i];
      if (rule && rule.action === "subagent" && rule.effect === "deny") denied += 1;
    }
    return "allow by default with " + denied + " deny rules";
  }
  if (blanket.effect === "ask") return "ask by default";
  return "unset (profile default)";
}

function editText(blanket) {
  if (blanket.effect === "allow") return "allow";
  if (blanket.effect === "deny") return "deny (no file writes)";
  if (blanket.effect === "ask") return "ask";
  return "unset (profile default)";
}

function formatBrief(agentID, rules, compact) {
  const shell = lastBlanket(rules, "shell");
  const web = (action) => lastBlanket(rules, action).effect || "unset (profile default)";
  const lines = [
    'Fusion permissions for agent "' + agentID + '" (findLast: the last matching rule wins):',
    "- edit: " + editText(lastBlanket(rules, "edit")),
    "- shell: " + shellText(rules, shell, compact),
    "- webfetch: " + web("webfetch") + "; websearch: " + web("websearch"),
    "- subagent: " + subagentText(rules, lastBlanket(rules, "subagent")),
    "Unmatched calls fall back to the profile default effect (often ask).",
  ];
  return lines.join("\n");
}

// Compact brief for one agent's permissions array. Returns "" when there is
// nothing usable to summarize, so the caller injects no part.
export function formatPermissionBrief(agentID, permissions) {
  if (typeof agentID !== "string" || !agentID) return "";
  if (!Array.isArray(permissions)) return "";
  const brief = formatBrief(agentID, permissions, false);
  if (brief.length <= MAX_BRIEF) return brief;
  const tight = formatBrief(agentID, permissions, true);
  return tight.length <= MAX_BRIEF ? tight : tight.slice(0, MAX_BRIEF - 3) + "...";
}


function alreadyInjected(system) {
  return system.some(
    (part) =>
      part &&
      typeof part === "object" &&
      ((part.metadata && part.metadata.source === MARKER) ||
        (typeof part.text === "string" &&
          part.text.startsWith("Fusion bootstrap:"))),
  );
}

function inject(input, text) {
  if (!Array.isArray(input.system)) input.system = [];
  if (alreadyInjected(input.system)) return;
  input.system.push({ type: "text", text, metadata: { source: MARKER } });
}

// Testable decision core: resolves parentage, picks the reminder for the
// session kind, appends the session agent's permission brief, and appends the
// active profile's tier table for primaries.
// options: { configDir?, env?, getSession, getAgent?, location?, log? }
// location is the plugin context's Location.Info, used only as a fallback for
// the session directory.
export function createContextHandler(options = {}) {
  const configDir =
    typeof options.configDir === "string" ? options.configDir : CONFIG_DIR;
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const getSession =
    typeof options.getSession === "function" ? options.getSession : null;
  const getAgent =
    typeof options.getAgent === "function" ? options.getAgent : null;
  // The plugin context's own directory, used when the session lookup yields no
  // location. Not cached either: it is only a fallback.
  const contextLocation =
    options.location && typeof options.location === "object" ? options.location : null;

  // Session cache: sessionID -> parentID. Only parentage is cached, because
  // only parentage is immutable per session; the session directory moves with
  // session_move, so it is read fresh on every primary request.
  const sessions = new Map();
  const CACHE_LIMIT = 2048;

  // Permission briefs: agent name -> brief text. Agent definitions and their
  // permission arrays are static per agent, so a brief is computed once. A
  // failed agent lookup is not cached, so the next request retries it.
  const briefs = new Map();

  // Resolved agent modes: agent name -> mode string. Agent definitions are
  // static, so a resolved mode is cached; a failed lookup is not cached.
  const modes = new Map();

  async function agentMode(agentID) {
    if (!getAgent || typeof agentID !== "string" || !agentID) return null;
    if (modes.has(agentID)) return modes.get(agentID);
    let mode = null;
    try {
      const info = await getAgent({ agentID });
      const agent = info && typeof info === "object" ? info.data || info : null;
      if (agent && typeof agent.mode === "string") mode = agent.mode;
    } catch {
      mode = null;
    }
    if (mode === null) return null;
    if (modes.size >= CACHE_LIMIT) modes.clear();
    modes.set(agentID, mode);
    return mode;
  }

  async function permissionBrief(agentID) {
    if (!getAgent || typeof agentID !== "string" || !agentID) return "";
    if (briefs.has(agentID)) return briefs.get(agentID);
    let permissions = null;
    try {
      const info = await getAgent({ agentID });
      const agent = info && typeof info === "object" ? info.data || info : null;
      if (agent && Array.isArray(agent.permissions)) permissions = agent.permissions;
    } catch {
      permissions = null;
    }
    if (!permissions) return "";
    const brief = formatPermissionBrief(agentID, permissions);
    if (briefs.size >= CACHE_LIMIT) briefs.clear();
    briefs.set(agentID, brief);
    return brief;
  }

  // Returns { known, parentID }. known=false means the session lookup failed
  // or returned nothing; the caller injects nothing for that request and the
  // next request retries.
  async function resolveParent(sessionID) {
    if (typeof sessionID !== "string" || !sessionID) {
      return { known: false, parentID: null };
    }
    if (sessions.has(sessionID)) {
      return { known: true, parentID: sessions.get(sessionID) };
    }
    if (!getSession) return { known: false, parentID: null };
    let info;
    try {
      info = await getSession({ sessionID });
    } catch {
      return { known: false, parentID: null };
    }
    if (!info || typeof info !== "object") {
      return { known: false, parentID: null };
    }
    const parentID =
      typeof info.parentID === "string" && info.parentID ? info.parentID : null;
    if (sessions.size >= CACHE_LIMIT) sessions.clear();
    sessions.set(sessionID, parentID);
    return { known: true, parentID };
  }

  // The session's current directory, reread on every primary request: a
  // session_move changes it, so caching it would keep the previous profile's
  // tier table until eviction or restart. Falls back to the plugin context's
  // directory, then "".
  async function sessionDirectory(sessionID) {
    if (getSession && typeof sessionID === "string" && sessionID) {
      try {
        const info = await getSession({ sessionID });
        const location = info && typeof info === "object" ? info.location : null;
        if (
          location &&
          typeof location === "object" &&
          typeof location.directory === "string" &&
          location.directory
        ) {
          return location.directory;
        }
      } catch {
        // Fall back to the plugin context directory below.
      }
    }
    const fallback =
      contextLocation && typeof contextLocation.directory === "string"
        ? contextLocation.directory
        : "";
    return fallback;
  }

  // "context" fires once per primary model request (the compaction, title
  // and generate requests have their own triggers), so this runs on every
  // step with a fresh system array.
  return async function onContext(input) {
    try {
      if (!input || typeof input !== "object") return;
      const agent = typeof input.agent === "string" ? input.agent : "";
      const parent = await resolveParent(input.sessionID);
      if (!parent.known) return;
      if (parent.parentID) {
        // Child session: this is a delegation, not a primary.
        const brief = await permissionBrief(agent);
        inject(input, brief ? CHILD_REMINDER + "\n\n" + brief : CHILD_REMINDER);
        return;
      }
      // Capability detection, not a roster: only an agent whose resolved info
      // reports mode "primary" is decorated at all. Unavailable agent info
      // (no getAgent option, failed or incomplete lookup) injects nothing for
      // this request; the next request retries.
      if ((await agentMode(agent)) !== "primary") return;
      // The Fusion reminder is for this configuration's own primaries: an agent
      // listed in the active profile's tiers.json agents mapping. Any other
      // primary (a project shipping its own agents) still gets the permission
      // brief and the tier table, never the Fusion workflow nudge.
      const brief = await permissionBrief(agent);
      const directory = await sessionDirectory(input.sessionID);
      const profile = resolveActiveProfile(env, configDir, directory);
      const tierTable = loadTierTable(configDir, profile);
      const wantsReminder =
        tierTable !== null && Object.hasOwn(tierTable.mapping, agent);
      const parts = [];
      if (wantsReminder) parts.push(PRIMARY_REMINDER);
      if (brief) parts.push(brief);
      if (tierTable) parts.push(formatTierTable(tierTable));
      if (parts.length === 0) return;
      inject(input, parts.join("\n\n"));
    } catch {
      // A reminder must never fail the model request it decorates.
    }
  };
}

export default Plugin.define({
  id: "fusion-bootstrap",
  async setup(ctx) {
    const onContext = createContextHandler({
      configDir: CONFIG_DIR,
      env: process.env,
      getSession: (args) => ctx.session.get(args),
      getAgent:
        ctx.agent && typeof ctx.agent.get === "function"
          ? (args) => ctx.agent.get(args)
          : null,
      // The typed hook input carries no location; the plugin context does.
      location: ctx.location,
    });

    const registration = await ctx.session.hook("context", onContext);
    console.log(
      "[fusion-bootstrap] context hook registered (primary: any agent whose mode is primary, with active-profile tiers; child: SKILLS contract; both: permission brief)",
    );

    return async () => {
      await registration?.dispose?.();
    };
  },
});

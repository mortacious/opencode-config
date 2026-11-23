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
// - Primary sessions (any agent whose resolved info reports mode "primary"):
//   check the skill catalog before acting; delegations load the
//   fusion-delegation-spec skill and fill a dispatch template from its
//   templates/ directory instead of a freehand task spec. When the ACTIVE
//   profile carries profiles/<name>/tiers.json, a compact model-tier table is
//   appended to the same part so the primary can pick a tier and pass its
//   literal model id on the subagent call. No roster list lives here: the mode
//   comes from agent info, so a new agents/<name>.md is picked up as-is.
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
// same way. Parentage is immutable per session, so it is cached; a failed
// lookup injects nothing and is retried on the next request rather than
// guessed.
//
// The active profile and its tier table are resolved fresh on every context
// call (cheap file reads, no cache) so an in-session profile switch is picked
// up on the next request. Tier loading is fail-soft: a missing or invalid
// tiers.json simply omits the block and never throws into the request.

import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Plugin } from "@opencode/plugin";

const MARKER = "fusion-bootstrap";

// index.js lives at <config>/plugin-src/fusion-bootstrap/index.js, so two
// levels up is the config dir bin/oc launches from (the same CONFIG_DIR that
// subagent-cap derives from its lib/ directory).
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

// bin/oc exports OPENCODE_CONFIG=<CONFIG_DIR>/profiles/<name>/opencode.jsonc.
// Returns the profile name, or null when the value is absent or shaped
// differently (base config, another file).
export function detectLaunchedProfile(env = process.env) {
  const raw = env && typeof env.OPENCODE_CONFIG === "string" ? env.OPENCODE_CONFIG : "";
  if (!raw) return null;
  const parts = raw.replace(/\\/g, "/").split("/");
  const file = parts.pop();
  const name = parts.pop();
  const container = parts.pop();
  if (file !== "opencode.jsonc" || container !== "profiles") return null;
  return isSafeProfileName(name) ? name : null;
}

// Machine-wide fallback record from <config>/.active-profile (format v1: a
// "global\t<name>" line; a legacy single-line file with no tab is the global
// record). Per-directory "location" records are deliberately ignored: the
// context hook has no reliable workspace directory for the session it
// decorates, so the machine-wide fallback is the best available answer.
export function readGlobalProfile(configDir) {
  let text;
  try {
    text = fs.readFileSync(join(configDir, ".active-profile"), "utf8");
  } catch {
    return null;
  }
  if (!text.includes("\t")) {
    const legacy = text.trim();
    return isSafeProfileName(legacy) ? legacy : null;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const fields = rawLine.split("\t");
    if (fields.length === 2 && fields[0] === "global") {
      const name = fields[1].trim();
      if (isSafeProfileName(name)) return name;
    }
  }
  return null;
}

// The profile whose tiers apply to this call: the launched overlay when
// OPENCODE_CONFIG names one, else the global fallback, else "default".
export function resolveActiveProfile(env = process.env, configDir = CONFIG_DIR) {
  return detectLaunchedProfile(env) || readGlobalProfile(configDir) || "default";
}

// Reads profiles/<name>/tiers.json fresh. Returns ordered rows
// [{name, model, description}] plus the agent->tier mapping, or null on any
// miss (absent file, bad JSON, unexpected shape) - never throws.
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
  const known = new Set();
  for (const name of Object.keys(tiers)) {
    const entry = tiers[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    const description =
      typeof entry.description === "string" ? entry.description.trim() : "";
    if (model === "" || description === "") return null;
    if (/[\r\n]/.test(entry.description)) return null;
    entries.push({ name, model, description });
    known.add(name);
  }
  if (entries.length === 0) return null;
  const mapping = {};
  for (const name of Object.keys(agents)) {
    const tier = agents[name];
    if (typeof tier !== "string" || !known.has(tier)) return null;
    mapping[name] = tier;
  }
  if (Object.keys(mapping).length === 0) return null;
  return { profile, entries, mapping };
}

// Compact appended block: every authored tier with its model and description,
// every agent's default tier, and the delegation policy. Kept short because it
// rides every request.
export function formatTierTable(table) {
  if (!table) return "";
  const lines = [
    'Model tiers (profile "' + table.profile + '", authored in profiles/' + table.profile + "/tiers.json):",
  ];
  for (const entry of table.entries) {
    lines.push("- " + entry.name + ": " + entry.model + " - " + entry.description);
  }
  const defaults = Object.keys(table.mapping)
    .sort()
    .map((name) => name + "=" + table.mapping[name])
    .join(", ");
  lines.push("- Agent defaults: " + defaults);
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
// options: { configDir?, env?, getSession, getAgent?, log? }
export function createContextHandler(options = {}) {
  const configDir =
    typeof options.configDir === "string" ? options.configDir : CONFIG_DIR;
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const getSession =
    typeof options.getSession === "function" ? options.getSession : null;
  const getAgent =
    typeof options.getAgent === "function" ? options.getAgent : null;

  // Parentage cache: sessionID -> parentID (null = root session).
  const parentIDs = new Map();
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

  // Returns { known, parentID }. known=false means the session lookup
  // failed or returned nothing; the caller injects nothing for that
  // request and the next request retries.
  async function resolveParent(sessionID) {
    if (typeof sessionID !== "string" || !sessionID) {
      return { known: false, parentID: null };
    }
    if (parentIDs.has(sessionID)) {
      return { known: true, parentID: parentIDs.get(sessionID) };
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
    if (parentIDs.size >= CACHE_LIMIT) parentIDs.clear();
    parentIDs.set(sessionID, parentID);
    return { known: true, parentID };
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
      // reports mode "primary" gets the primary nudge. Unavailable agent info
      // (no getAgent option, failed or incomplete lookup) injects nothing for
      // this request; the next request retries.
      if ((await agentMode(agent)) !== "primary") return;
      const brief = await permissionBrief(agent);
      const profile = resolveActiveProfile(env, configDir);
      const tierTable = loadTierTable(configDir, profile);
      let text = brief ? PRIMARY_REMINDER + "\n\n" + brief : PRIMARY_REMINDER;
      if (tierTable) text += "\n\n" + formatTierTable(tierTable);
      inject(input, text);
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

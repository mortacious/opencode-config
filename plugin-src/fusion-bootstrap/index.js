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
// - Primary sessions (build, plan): check the skill catalog before acting;
//   delegations load the fusion-delegation-spec skill and fill a dispatch
//   template from its templates/ directory instead of a freehand task spec.
//   When the ACTIVE profile carries profiles/<name>/tiers.json, a compact
//   model-tier table is appended to the same part so the primary can pick a
//   tier and pass its literal model id on the subagent call.
// - Child sessions (any session with a structural parentID): the task prompt
//   is the full specification, load the skills it names, and the report MUST
//   begin with the "SKILLS:" line so a skipped load is visible.
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

const PRIMARY_AGENTS = new Set(["build", "plan"]);

const MARKER = "fusion-bootstrap";

// index.js lives at <config>/plugin-src/fusion-bootstrap/index.js, so two
// levels up is the config dir bin/oc launches from (the same CONFIG_DIR that
// subagent-cap derives from its lib/ directory).
const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TIER_KEYS = ["big", "medium", "small", "vision"];

const PRIMARY_REMINDER = [
  "Fusion bootstrap:",
  "- Before acting, check the skill catalog.",
  "- When delegating, load the fusion-delegation-spec skill and fill a dispatch template from its templates/ directory; never freehand a task spec.",
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

// Reads profiles/<name>/tiers.json fresh. Returns a normalized table, or null
// on any miss (absent file, bad JSON, unexpected shape) - never throws.
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
  const models = {};
  for (const key of TIER_KEYS) {
    const ref = tiers[key];
    if (typeof ref !== "string" || ref.trim() === "") return null;
    models[key] = ref.trim();
  }
  const mapping = {};
  for (const name of Object.keys(agents)) {
    const tier = agents[name];
    if (typeof tier !== "string" || !TIER_KEYS.includes(tier)) return null;
    mapping[name] = tier;
  }
  if (Object.keys(mapping).length === 0) return null;
  return { profile, models, mapping };
}

// Compact appended block: the four tier models, every agent's default tier,
// and the delegation policy. Kept short because it rides every request.
export function formatTierTable(table) {
  if (!table) return "";
  const lines = [
    'Model tiers (profile "' + table.profile + '", authored in profiles/' + table.profile + "/tiers.json):",
  ];
  for (const key of TIER_KEYS) {
    lines.push("- " + key + ": " + table.models[key]);
  }
  const defaults = Object.keys(table.mapping)
    .sort()
    .map((name) => name + "=" + table.mapping[name])
    .join(", ");
  lines.push("- Agent defaults: " + defaults);
  lines.push(
    "Policy: choose a tier per delegation, default to the delegating agent's tier; " +
      "downgrade only for clearly mechanical work; whole-branch final review uses big; " +
      "vision tasks use the vision tier; to override, pass the tier's model id as the " +
      "subagent tool's model parameter.",
  );
  return lines.join("\n");
}

// One system part per request, tagged so a re-registered hook (hot reload,
// provider retry reusing the same context object) cannot inject twice.
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
// session kind, and appends the active profile's tier table for primaries.
// options: { configDir?, env?, getSession, log? }
export function createContextHandler(options = {}) {
  const configDir =
    typeof options.configDir === "string" ? options.configDir : CONFIG_DIR;
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const getSession =
    typeof options.getSession === "function" ? options.getSession : null;

  // Parentage cache: sessionID -> parentID (null = root session).
  const parentIDs = new Map();
  const CACHE_LIMIT = 2048;

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
        // Child session: this is a delegation, not an orchestrator.
        inject(input, CHILD_REMINDER);
        return;
      }
      if (PRIMARY_AGENTS.has(agent)) {
        const profile = resolveActiveProfile(env, configDir);
        const tierTable = loadTierTable(configDir, profile);
        const text = tierTable
          ? PRIMARY_REMINDER + "\n\n" + formatTierTable(tierTable)
          : PRIMARY_REMINDER;
        inject(input, text);
      }
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
    });

    const registration = await ctx.session.hook("context", onContext);
    console.log(
      "[fusion-bootstrap] context hook registered (primary: build, plan with active-profile tiers; child: SKILLS contract)",
    );

    return async () => {
      await registration?.dispose?.();
    };
  },
});

// fusion-bootstrap: session-start skill reminders for the Fusion tree.
//
// Failure this plugin addresses: a primary session delegates, or a delegated
// session starts, without loading the skills the work needs - and nothing in
// the transcript ever shows that the load was skipped. Two short reminders are
// injected as an extra system part on every primary model request (the seam
// opencode's own plugins use: ctx.session.hook("context", ...) receives the
// mutable SessionContext, and pushing onto input.system adds an instruction
// without writing a transcript message, so nothing accumulates):
//
// - Primary sessions (build, plan): check the skill catalog before acting;
//   delegations load the fusion-delegation-spec skill and fill a dispatch
//   template from its templates/ directory instead of a freehand task spec.
// - Child sessions (any session with a structural parentID): the task prompt
//   is the full specification, load the skills it names, and the report MUST
//   begin with the "SKILLS:" line so a skipped load is visible.
//
// Parent detection is structural (ctx.session.get -> Info.parentID), never a
// tag parsed out of the prompt: obra/superpowers skips child sessions the
// same way. Parentage is immutable per session, so it is cached; a failed
// lookup injects nothing and is retried on the next request rather than
// guessed.

import { Plugin } from "@opencode/plugin";

const PRIMARY_AGENTS = new Set(["build", "plan"]);

const MARKER = "fusion-bootstrap";

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

export default Plugin.define({
  id: "fusion-bootstrap",
  async setup(ctx) {
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
      let info;
      try {
        info = await ctx.session.get({ sessionID });
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
    const onContext = async (input) => {
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
          inject(input, PRIMARY_REMINDER);
        }
      } catch {
        // A reminder must never fail the model request it decorates.
      }
    };

    const registration = await ctx.session.hook("context", onContext);
    console.log(
      "[fusion-bootstrap] context hook registered (primary: build, plan; child: SKILLS contract)",
    );

    return async () => {
      parentIDs.clear();
      await registration?.dispose?.();
    };
  },
});

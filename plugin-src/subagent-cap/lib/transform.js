// subagent-cap transform: wraps the spawn tool's execute with the concurrency
// gate. Kept separate from index.js so tests can drive it with a fake editor.
//
// Transforms REPLAY on every tool-registry rebuild (a switch re-registers and
// the registry re-applies every transform onto a fresh base value, see
// profile-switcher/index.ts). The wrapper therefore marks itself with the
// exported marker and never stacks a second wrapper on an already-wrapped
// execute.

import { Error as ToolError } from "@opencode/plugin/promise/tool";

// Own-property marker on the wrapped execute function. Symbol.for makes the
// marker stable even if this module is instantiated twice.
export const WRAPPED_MARKER = Symbol.for("subagent-cap.wrapped");

// Log replay dedupe: transforms replay on every registry rebuild, so the same
// outcome would otherwise re-print on each rebuild. These sets live for the
// process (module scope on purpose - the installed plugin module is one
// instance) and are keyed per configured pattern.
const successLogged = new Set();
const noMatchWarned = new Set();

function patternKey(toolIds) {
  return Array.isArray(toolIds) ? toolIds.join(",") : String(toolIds);
}

// True the first time a given pattern resolved to this wrapped-id set; used by
// index.js for the "cap N active" success line.
export function claimSuccessLog(toolIds, wrapped) {
  const key = patternKey(toolIds) + "->" + wrapped.join(",");
  if (successLogged.has(key)) return false;
  successLogged.add(key);
  return true;
}

// True the first time a given pattern failed to match this available-id set;
// re-warns when the registry changes, so a still-broken config stays visible.
export function claimNoMatchWarn(toolIds, availableIds) {
  const key = patternKey(toolIds) + "!=" + availableIds.join(",");
  if (noMatchWarned.has(key)) return false;
  noMatchWarned.add(key);
  return true;
}

// Install the wrapper for every configured tool id that actually exists in
// the registry. ToolEditor.update on a missing id is a SILENT no-op, so the
// editor.list() probe decides what to wrap; when nothing matches, warn loudly
// with both the configured and the available ids (once per pattern/registry
// pair - replays are silent).
export function installCap({ editor, toolIds, state, logger = console }) {
  const wanted = new Set(toolIds);
  const available = editor.list();
  const availableIds = available.map((tool) => tool.id);
  const matches = available.filter((tool) => wanted.has(tool.id));

  if (matches.length === 0) {
    if (claimNoMatchWarn(toolIds, availableIds)) {
      logger.warn(
        "[subagent-cap] WARNING: no subagent tool id matched - the cap is NOT enforced. " +
          "configured toolIds=" +
          JSON.stringify(toolIds) +
          " available tool ids=" +
          JSON.stringify(availableIds)
      );
    }
    return { wrapped: [], availableIds };
  }

  const wrapped = [];
  for (const match of matches) {
    editor.update(match.id, (tool) => {
      const original = tool.execute;
      if (typeof original !== "function") return;
      if (original[WRAPPED_MARKER]) return; // already wrapped: replay, do nothing

      const wrappedExecute = async (input, context) => {
        let record = state.tryAcquire();
        if (!record) {
          // At cap: free any tracked child whose time.idle is already set,
          // then retry once.
          await state.reconcile();
          record = state.tryAcquire();
          if (!record) {
            // Tool.Error (not a bare Error) so the message reaches the
            // calling agent's tool result as a self-describing failure. The
            // same text is mirrored into the optional metadata field
            // (Tool.Error carries metadata?: Record<string, unknown>) so it
            // survives a promise adapter that flattens the message.
            const message = state.blockMessage();
            throw new ToolError({ message, metadata: { subagentCap: message } });
          }
        }
        let result;
        try {
          result = await original(input, context);
        } catch (err) {
          state.release(record);
          throw err;
        }
        try {
          await state.settle(record, result, context && context.sessionID);
        } catch {
          // Accounting must never turn a successful spawn into a failure.
          state.release(record);
        }
        return result;
      };
      wrappedExecute[WRAPPED_MARKER] = true;
      tool.execute = wrappedExecute;
    });
    wrapped.push(match.id);
  }

  return { wrapped, availableIds };
}

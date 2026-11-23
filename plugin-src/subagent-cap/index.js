// subagent-cap: cap concurrent subagent spawns per OpenCode server instance.
//
// Effective cap = options.profiles[detectedProfile] ?? options.max, where the
// launched profile comes from OPENCODE_CONFIG exactly like
// profile-switcher's detectLaunchedProfile. max 0 (the default) is unlimited
// and leaves the tool unwrapped; the base config registers
// {"max": 0, "profiles": {"cheap-local": 3}}.
//
// The built-in spawn tool's real registration id on this build is unverified
// ("subagent" per upstream V2 source, "task" in some repo artifacts), so every
// configured id that exists is wrapped and a loud warning fires when none
// matches. Blocked spawns throw Tool.Error with a self-describing message
// (cap / running count / profile / remedy) so the orchestrator sees the block
// in the tool result.
//
// Counter scope: per server instance, not machine-wide - spawns from another
// OpenCode window bypass the cap.
//
// Future key: if upstream ships experimental.subagent_concurrency, this
// plugin should be disabled; PluginOptions carries only this plugin's own
// options, so the global config key is not readable cheaply here.

import { Plugin } from "@opencode/plugin";

import {
  createCapState,
  detectLaunchedProfile,
  normalizeOptions,
  resolveEffectiveCap,
} from "./lib/cap.js";
import { installCap, claimSuccessLog } from "./lib/transform.js";

export default Plugin.define({
  id: "subagent-cap",
  async setup(ctx) {
    const opts = normalizeOptions(ctx.options);
    const profile = detectLaunchedProfile();
    const cap = resolveEffectiveCap(opts, profile);

    if (!(cap > 0)) {
      console.log(
        "[subagent-cap] unlimited (profile=" +
          (profile ?? "base") +
          ", max=" +
          opts.max +
          "); leaving the spawn tool unwrapped"
      );
      return;
    }

    const state = createCapState({
      cap,
      profile,
      getSession: (sessionID) => ctx.session.get({ sessionID }),
    });

    let registration;
    try {
      registration = await ctx.tool.transform((editor) => {
        const outcome = installCap({ editor, toolIds: opts.toolIds, state });
        // Replays on registry rebuild: log the success line once per pattern.
        if (
          outcome.wrapped.length > 0 &&
          claimSuccessLog(opts.toolIds, outcome.wrapped)
        ) {
          console.log(
            "[subagent-cap] cap " +
              cap +
              ' active under profile "' +
              (profile ?? "base") +
              '"; wrapped tool ids=' +
              JSON.stringify(outcome.wrapped)
          );
        }
      });
    } catch (err) {
      console.warn(
        "[subagent-cap] WARNING: tool transform registration failed - the cap is NOT enforced: " +
          (err && err.message ? err.message : String(err))
      );
      return;
    }

    return async () => {
      if (registration && typeof registration.dispose === "function") {
        await registration.dispose();
      }
    };
  },
});

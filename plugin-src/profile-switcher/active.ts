// profile-switcher: active-profile resolution for one plugin instance.
//
// Delegates the precedence to the shared resolver
// (plugin-src/shared/active-profile.js): launched OPENCODE_CONFIG overlay >
// OC_PROFILE (only when it names a usable profile) > this directory's
// location record in .active-profile (canonical match, later wins) > the last
// usable global record > "default". A launched overlay is reported as
// launchSuppressed: the base config already carries it, so no runtime
// transforms apply. OC_PROFILE is a launch-only override and is never
// persisted; this module never writes .active-profile.
//
// Kept free of plugin imports so a plain-node test can import it directly.

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  detectLaunchedProfile,
  resolveProfile,
} from "../shared/active-profile.js";

export interface ActiveProfileResolution {
  // The profile name that applies to this instance.
  name: string;
  // True only when the name came from a launched OPENCODE_CONFIG overlay.
  launchSuppressed: boolean;
}

// A profile is usable when it is the literal "default" (an explicit
// per-directory default is meaningful without a default/ overlay on disk) or
// its profile overlay exists.
export function profileUsable(profilesDir: string, name: string): boolean {
  if (name === "default") return true;
  return existsSync(join(profilesDir, name, "opencode.jsonc"));
}

export interface ActiveProfileOptions {
  // CONFIG_DIR (owns .active-profile).
  configDir: string;
  // The profile overlay directory this instance reads (profilesDir option).
  profilesDir: string;
  // This instance's location directory.
  directory?: string;
  // Injectable for tests; defaults to process.env.
  env?: Record<string, string | undefined>;
}

export function resolveInstanceProfile(
  options: ActiveProfileOptions
): ActiveProfileResolution {
  const env = options.env ?? process.env;
  const launched = detectLaunchedProfile(env);
  if (launched) {
    return { name: launched, launchSuppressed: true };
  }
  return {
    name: resolveProfile({
      env,
      configDir: options.configDir,
      directory: options.directory,
      profileExists: (name) => profileUsable(options.profilesDir, name),
    }),
    launchSuppressed: false,
  };
}

// Type surface for the shared active-profile resolver
// (plugin-src/shared/active-profile.js). The module itself stays plain JS so
// a plain-node script and every plugin can import it; this declaration only mirrors its
// documented contract for the TypeScript consumers (profile-switcher).

export interface ActiveProfileRecord {
  directory: string;
  name: string;
}

export interface ActiveProfileState {
  global: string | null;
  locations: ActiveProfileRecord[];
}

export interface ResolveProfileOptions {
  env?: Record<string, string | undefined>;
  configDir?: string;
  directory?: string;
  profileExists?: (name: string) => boolean;
}

export function isSafeProfileName(name: unknown): boolean;
export function detectLaunchedProfile(
  env?: Record<string, string | undefined>
): string | null;
export function parseActiveProfileText(text: string): ActiveProfileState;
export function parseActiveProfile(configDir: string): ActiveProfileState;
export function canonicalDirectory(directory: string): string;
export function resolveProfile(options?: ResolveProfileOptions): string;

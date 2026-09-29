// fusion-tools: secret redaction over rendered transcript text.
// Single pass, replace every hit with [REDACTED]. Never throws.

const REDACTED = "[REDACTED]";

const PATTERNS = [
  // OpenAI-style project/API keys
  "sk-[A-Za-z0-9_-]{10,}",
  // GitHub tokens
  "gh[pousr]_[A-Za-z0-9]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  // AWS access key id
  "AKIA[0-9A-Z]{16}",
  // bearer / authorization header values
  "(?i:bearer[ \\t]+[A-Za-z0-9._\\-+/=]{16,})",
  // password=... / secret: ... / token = "..." style assignments
  "(?i:\\S*(?:password|passwd|secret|token|api[ _-]?key)\\b[ \\t]*[=:][ \\t]*[\"']?[A-Za-z0-9+/_.\\-]{6,})",
  // long hex runs
  "\\b[a-f0-9]{40,}\\b",
  // long base64 runs (with optional padding)
  "\\b[A-Za-z0-9+/]{40,}={0,2}\\b",
];

let compiled = null;

function compile() {
  if (compiled) return compiled;
  compiled = new RegExp(PATTERNS.map((p) => "(?:" + p + ")").join("|"), "g");
  return compiled;
}

export function redactPatterns() {
  return PATTERNS.slice();
}

export function redactText(text) {
  if (typeof text !== "string" || text === "") return text;
  try {
    return text.replace(compile(), REDACTED);
  } catch {
    return text;
  }
}

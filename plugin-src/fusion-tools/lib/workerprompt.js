// fusion-tools: composes the prompt sent to a fanout worker session.
// Pure string composition - unit tested. The prompt carries: the shared
// context (if any), the task text, the absolute working directory, the
// submit_result instruction, and the JSON-stringified outputSchema (or the
// no-schema fallback wording).

export function composeWorkerPrompt({ context, task, worktreePath, outputSchema }) {
  const lines = [];
  lines.push("You are a fanout worker completing ONE self-contained task.");
  lines.push("");
  lines.push("Working directory (your sandbox - do not create or modify anything outside it):");
  lines.push(worktreePath);
  if (context && String(context).trim()) {
    lines.push("");
    lines.push("Shared context from the parent:");
    lines.push(String(context).trim());
  }
  lines.push("");
  lines.push("Task:");
  lines.push(String(task || "").trim());
  lines.push("");
  if (outputSchema && typeof outputSchema === "object") {
    lines.push(
      "When done, call the submit_result tool EXACTLY ONCE with a `data` object matching this JSON schema:",
    );
    let schemaText;
    try {
      schemaText = JSON.stringify(outputSchema, null, 2);
    } catch {
      schemaText = String(JSON.stringify(outputSchema));
    }
    lines.push(schemaText);
  } else {
    lines.push(
      "When done, call the submit_result tool EXACTLY ONCE and put your result in `data` (no schema was given - any JSON object is acceptable).",
    );
  }
  lines.push("");
  lines.push(
    "Rules: never run git commit or git push; never touch files outside the working directory; if the task cannot be completed, call submit_result with an `error` string explaining why instead of data.",
  );
  return lines.join("\n");
}

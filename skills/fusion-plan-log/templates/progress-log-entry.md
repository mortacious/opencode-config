# Progress Log Entry Template

Copy one block per completed plan step into `.plans/<branch>.md`. Delete the comment lines after filling; keep the entry itself to one or two lines.

## Step entry (max two lines)

- `<YYYY-MM-DD>` Step `<NN>` - `<title>`: `<one-line outcome>`; verified: `<command>` => `pass|fail`

Slot notes:

- `<YYYY-MM-DD>` - the date the step closed, in ISO form.
- `Step <NN>` - the zero-padded step number exactly as it appears in `## Plan`.
- `<title>` - the step's short title, reusing the plan's own words.
- `<one-line outcome>` - what actually changed, as one clause with no history.
- `verified: <command> => pass|fail` - the exact command that was run and its real result, not the expected one.

## Decision entry (one line)

`<what> - <why>; rejected: <alternative>`

Slot notes:

- `<what>` - the decision that was made, named concretely.
- `<why>` - the reason that made it win, in one clause.
- `rejected: <alternative>` - the option that lost, so later steps do not re-litigate it.

## Boundaries

- Reference the file path (`path:line`), commit hash, or review finding id instead of quoting content.
- No code blocks, pasted output, narratives, or multi-paragraph status.
- Append only: never rewrite an existing cumulative entry.
- One log file stays under about 10 KB; `scripts/validate-config` fails it otherwise.

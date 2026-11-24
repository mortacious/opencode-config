---
name: kernel
description: Use when a task needs persistent Python state across tool calls - data-heavy analysis, long-lived objects or loaded models, conda/venv environments, or notebook output - through the kernel tool and kernel_export. Covers interpreter selection, timeouts, reset, image outputs, and export. Do not use it for JavaScript (that stays on execute) or for one-shot shell commands.
---

# Kernel

## Overview

The `kernel` tool runs Python in a persistent Jupyter kernel owned by the plugin
(`plugin-src/kernel/`). One cell per call, and variables, imports, and open handles survive
between calls and across compaction. Each session gets its own kernel, so a subagent never sees
its parent's state, and a kernel is never shared between two sessions.

Use it instead of `execute` whenever the work is Python and the state matters.

## When to Use

- Data-heavy analysis where loading a dataframe, model, or dataset once and querying it many
  times is the point.
- A conda or venv environment whose interpreter is not the default `python3`.
- Work that needs images out of matplotlib or another plotting library.
- A notebook is the deliverable: run cells, then export with `kernel_export`.

Do not use it for JavaScript - that stays on `execute`, which is the JS runtime. Do not use it
for one-shot shell commands either; `shell` is cheaper and needs no kernel.

## Core Pattern

### One cell per call

Every `kernel` call is one cell. State persists across calls, across tool dispatches, and across
compaction - the kernel outlives the conversation window. Keep cells small enough to read back:
define a function in one cell, call it in the next.

### Interpreter selection

The `kernel` argument takes either an absolute Python path (`/opt/conda/envs/sci/bin/python`) or
a Jupyter kernelspec name (`python3`, or any installed spec). Empty means auto-discover, which
checks, in order:

1. `KERNEL_PYTHON`
2. `$VIRTUAL_ENV/bin/python`
3. `$CONDA_PREFIX/bin/python`
4. `<project>/.venv/bin/python`
5. `<project>/venv/bin/python`
6. `python3`

The first candidate that imports `ipykernel` wins. An absolute path is validated: it must be an
executable file and must import `ipykernel`, or the call fails with the install command. There
is no managed environment - the selected env must already carry `ipykernel`:

```
<env>/bin/python -m pip install ipykernel
conda install -n <env> ipykernel
```

### Prerequisites and trust

`install.sh` runs `scripts/check-runtime.sh`, and the bootstrap fails when no selected interpreter
has `ipykernel` (that is a hard gate; warnings for `debugpy`, ptrace, and mcp-debugger do not
fail). The remedy is to activate a conda/venv env with `ipykernel`, set `KERNEL_PYTHON` to its
interpreter, or run `scripts/check-runtime.sh --python <env>/bin/python` to check and report a
specific env. `KERNEL_HOST_PYTHON` is only the optional host interpreter for named kernelspecs; it
must import `jupyter_client` when set.

The `kernel` and `kernel_export` tools are available to both `orchestrator` and `sidekick`. They
are a code-execution surface: treat a kernel cell with the same trust as a shell command, because
it runs arbitrary Python in the selected environment.

### Timeout

`timeout` is seconds, default 30, `0` disables the deadline, and values above 3600 (and
negatives) are rejected.
A timeout first sends SIGINT. If the kernel acknowledges, the call reports `timeout` with
`lost:false` and the kernel keeps its state - a slow cell costs a retry, not the session. Only an
unresponsive kernel is shut down, reported `lost:true`, and its state is gone.

### Reset

`reset:true` shuts the kernel down and starts a fresh one: all state is wiped. Use it to switch
interpreters after a `kernel` change, or to get a clean namespace. The loss is intentional - do
not reset to "fix" a slow cell, use a longer timeout.

### Outputs

Captured stdout/stderr are returned inline up to 50 KiB; past that the full text is written to a
log file and the result carries its path. Read the log or narrow the cell rather than raising
the cap. Images (matplotlib, PIL, anything producing a MIME image bundle) are saved to disk and
returned as file paths. To inspect one, hand the path to the vision tier (the `analyst` agent) -
the kernel does not describe pixels.

### Panel and image previews

The `/kernel` panel renders the session journal: syntax-highlighted cells, their outputs,
images, and reset dividers, refreshed live by the plugin's `kernel` RPC (`cell` and `reset`
events after each call; `cells` reads the same `meta.json` and `cells.jsonl` as export, and an
empty journal shows an empty panel). Open it with the `/kernel` command or the `Kernel cells`
entry in the command palette; the panel renders PNG and JPEG outputs up to 3 images per cell,
with a `+N more` line past that, and a truncated or non-base64 image payload shows a
`[truncated image data]` placeholder instead of an image. Inline image previews in the transcript
separately need `"session": { "image_preview": true }` at the top level of `opencode.jsonc`: PNG
and JPEG outputs render in place up to 3 per cell, 2 MiB each, 6 MiB total, while the saved file
paths remain in the result metadata.

### Notebook export

`kernel_export({path, title})` writes the session journal to an nbformat 4.5 `.ipynb`:

- `path` is relative to the project root; `.ipynb` is appended when missing.
- `title` is optional and becomes a leading markdown cell.
- The export runs on `python3` by default and needs only the standard library (the journal and
  metadata are the inputs); set `PYTHON_EXPORT` to an absolute interpreter path to override which
  Python performs the export. That override is export-only - it does not select the kernel.
- Full outputs and images from every executed cell are included, not the inline truncation.
- Reset boundaries appear as markdown divider cells, so a state wipe is visible in the notebook.
- The write is atomic: a partial file is never left behind.
- Guards: more than 1000 code cells stops the export, and any single cell over 2 MiB is
  truncated with a notice.

Use `notebooks/<topic>.ipynb` so exports stay together and out of the repo root.

### Existing notebooks

For existing `.ipynb` files, the community `opencode-ipynb` plugin, if installed, is the right
tool for inspecting, reading, editing, running, cleaning, and LSP-checking those files. This
kernel is session-scoped and does not need a notebook file to exist. `kernel_export` writes a
standard nbformat notebook that such a tool, or Jupyter itself, can then open and edit.

### State directory

Journals, metadata, and the ephemeral kernelspec live in `$XDG_STATE_HOME/opencode/kernel`, or
`~/.local/state/opencode/kernel/<sessionID>` when `XDG_STATE_HOME` is unset. The directory is
safe to delete when no session is running; a deleted state dir only loses the export journal.

### Non-Python kernels

Any installed Jupyter kernelspec works - for example `xcpp17` from xeus-cling - because the host
launches the spec's own command. Only the Python path is validated; a non-Python spec is
bring-your-own and its failures surface as kernel errors.

## Examples

```
kernel({code: "import pandas as pd\ndf = pd.read_parquet('data/events.parquet')\ndf.shape"})
```

```
kernel({code: "df.groupby('kind').size()", timeout: 120})
```

```
kernel({code: "import matplotlib.pyplot as plt\nplt.plot(df['t']); plt.savefig('out.png')"})
```

```
kernel({code: "import sys; print(sys.executable)", kernel: "/opt/conda/envs/sci/bin/python"})
```

```
kernel_export({path: "notebooks/events-analysis", title: "Events analysis"})
```

## Common Mistakes

- Running each cell as its own one-off `execute` script and losing the loaded data.
- Assuming a subagent shares the parent kernel - it has a separate one with separate state.
- Asking the kernel to run JavaScript; `execute` is the JS runtime.
- Raising the timeout when the real problem is a cell that blocks forever or a hung kernel;
  check the result's `lost` flag to see whether the state survived.
- Checking in an exported notebook built from an env that cannot be reproduced - record the
  interpreter path in a cell when the analysis matters.
- Exporting to the repo root or with an absolute path outside the project.

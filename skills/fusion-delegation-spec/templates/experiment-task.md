# Experiment Task Template

Copy this into a `subagent` delegation for one experiment: a run, a sweep step, or a baseline reproduction. Every section is required: fill it, or write "none" with a reason. Delete the guidance comment lines before sending.

## Objective

<!-- One hypothesis and one measurement. State what is compared against what, and which number decides it. Not "improve segmentation" but "does adding temporal fusion raise mIoU on split B over the frame-only baseline". -->

_Hypothesis: <claim>. Measurement: <metric on which split>._

## Inputs and paths

<!-- Exact paths or identifiers, no "the dataset". Name the split each root selects, and the config or calibration the run depends on. -->

- Dataset root: `<path>` (split: `<train/val/test file>`)
- Sensor config / calibration: `<path>`
- Code entry point: `<path or command>`
- Seeds: `<list>`
- Initial checkpoint (if any): `<path or "none - from scratch">`

## Artifact contract

<!-- The output shape a reviewer can check without rerunning: file names, columns, naming scheme, log format. -->

- Metrics file: `<path>` with columns `<col1, col2, ...>`
- Per-run output dir: `<path pattern>`
- Checkpoint naming: `<pattern>`
- Figures: `<paths>`
- Log format: `<path and what each line records>`

## Protocol constraints

<!-- What must not vary inside this run, so the number means something. -->

- Compute budget: `<GPU/CPU, wall-clock cap>`
- Leakage rule: `<how train/val/test are kept disjoint - scenes, subjects, sessions>`
- Fixed protocol: `<split, preprocessing, hyperparameters, eval script that must not be tuned>`
- May tune: `<explicitly allowed knobs, or "none">`

## Verification

<!-- The rerun command, the expected metric range against a named baseline, and the sanity checks that catch a silent failure. Every number must trace to this run's outputs or a named source; every cited work must resolve to an identifier. -->

```bash
<rerun or eval command>
```

_Expected: `<metric>` in `<range>` vs baseline `<name = value from source>`. Sanity checks: `<loss decreasing, mask non-empty, residual bound>`._

Evidence: each reported number traces to this run's output file or a stated source; any reference cited resolves to an identifier (DOI, arXiv ID, DBLP or Semantic Scholar entry), and one that does not resolve is reported under GAPS, never cited.

## Skills to load

<!-- Skill names the executor must load before starting. Keep this short. -->

- `<skill-name>`

## Model tier

<!-- REQUIRED: one of big | medium | small | vision. Name the agent's default tier unless overriding, then give that tier's model id from the injected Model tiers table. -->

- Tier: big | medium | small | vision
- Model override: `<provider>/<model>` from the injected table, or "none - default"

## Report contract

<!-- Numbers first, with the command that produced them. A run summary without the metrics line does not count. -->

Condensed report - this is input for an expensive orchestrator; no bulk output.

- **SKILLS**: comma-separated ids loaded before starting, or "none"
- **STATUS**: complete | partial | blocked | escalate
- **CHANGES**: one line per file or artifact actually produced, from the real diff and the real output dir
- **VERIFIED**: max 10 result bullets - each number with units, plus the command that printed it and the comparison against the expected range
- **GAPS**: deviations from the protocol, failed runs, or "none" - max 5

## Stop conditions

<!-- Stop and escalate instead of guessing. -->

- An input path is missing, or the split does not match the spec.
- The expected metric range cannot be met without changing the fixed protocol.
- The run needs more compute than the stated budget.
- A sanity check fails in a way that suggests leakage or a broken pipeline.
- The work outgrows one experiment. Stop and report partial instead of starting a second run silently.

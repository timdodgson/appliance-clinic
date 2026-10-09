# Prompts

Every language-model and Jev prompt the runtime sends is registered in [`registry.json`](registry.json):

| Field | Meaning |
|---|---|
| `id` | Stable identifier, e.g. `diagnosis.compose.system`. It never changes; a replacement prompt gets a new id |
| `version` | Integer, the latest changelog entry |
| `purpose`, `owner`, `consumers` | What it does, which component owns it, and who depends on its output |
| `source` | The exact declarations (file and names) that make up the prompt. The prompts stay in the runtime code, next to the logic that fills them |
| `input`, `output` | The contract: what fills the prompt and what the caller expects back |
| `runtimeVersion` | Where one exists, the constant the runtime stamps on its output (for example the transcript review's `REVIEW_PROMPT_VERSION`) and its current value |
| `changelog` | One entry per version: date, fingerprint of the source, and what changed |

[`registry.test.mjs`](registry.test.mjs) fails when a prompt's source no longer matches its latest version.

## Changing a prompt

1. Change the prompt in its source file.
2. Run `node prompts/fingerprint.mjs` and copy the new fingerprint.
3. In `registry.json`, increase `version` and append a changelog entry: the date, the fingerprint and what changed.
4. If the prompt has a `runtimeVersion`, bump that constant too and record the new value.
5. Evaluate the change before release, then deploy it as a reviewed runtime release:
   - **diagnosis prompts:** the `/part-finder` contract, the smoke baseline and the transcript-review judge
   - **judge prompts:** a comparison run against the previous version

Moving a prompt to another file without changing it keeps the fingerprint. Update `source` only.

## Prompts and who uses them

| Id | Used by |
|---|---|
| `diagnosis.compose.system`, `diagnosis.compose.intent-hints`, `diagnosis.compose.turn` | Legacy COMPOSE: every S4R `/part-finder` request, and AC turns not under canonical control |
| `diagnosis.jev.understand` | Jev UNDERSTAND: every S4R `/part-finder` request, and AC orchestrated turns |
| `diagnosis.canonical.compose`, `diagnosis.jev.mc1` | Canonical control (AC, allow-listed journeys) |
| `review.transcript.llm`, `review.transcript.jev` | The scheduled transcript review and admin re-review |
| `benchmark.acq.judge`, `benchmark.gold-v2.judge` | Admin test-area benchmarks |

Prompts used by S4R requests are S4R-facing: a change to them changes `/part-finder` replies.

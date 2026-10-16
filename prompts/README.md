# Prompts

Every language-model prompt the runtime sends is registered in [`registry.json`](registry.json):

| Field | Meaning |
|---|---|
| `id` | Stable identifier, e.g. `diagnosis.advisor`. It never changes; a replacement prompt gets a new id |
| `version` | Integer, the latest changelog entry |
| `purpose`, `owner`, `consumers` | What it does, which component owns it, and who depends on its output |
| `source` | The exact declarations (file and names) that make up the prompt. The prompts stay in the runtime code, next to the logic that fills them |
| `input`, `output` | The contract: what fills the prompt and what the caller expects back |
| `runtimeVersion` | Where one exists, the constant the runtime stamps on its output and its current value |
| `changelog` | One entry per version: date, fingerprint of the source, and what changed |

[`registry.test.mjs`](registry.test.mjs) fails when a prompt's source no longer matches its latest version.

## Changing a prompt

1. Change the prompt in its source file.
2. Run `node prompts/fingerprint.mjs` and copy the new fingerprint.
3. In `registry.json`, increase `version` and append a changelog entry: the date, the fingerprint and what changed.
4. If the prompt has a `runtimeVersion`, bump that constant too and record the new value.
5. Evaluate the change before release, then deploy it as a reviewed runtime release:
   - the engine test suite (including the GOLD guardrail regression), the scripted evaluation (`evaluation/scripted/run.cjs`) and the live AC journeys on the deployed build

Moving a prompt to another file without changing it keeps the fingerprint. Update `source` only.

## Prompts and who uses them

| Id | Used by |
|---|---|
| `diagnosis.advisor` | The advisor (Claude Opus with tools), every customer turn (ADR 0023) |
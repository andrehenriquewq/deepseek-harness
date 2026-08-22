# Agent Note: Preamble-only tool calls from Gemini-family models

Status: implemented

English | [中文](2026-08-22-preamble-only-tool-calls.zh.md)

## Problem

Gemini 3.x models reached through an OpenAI-protocol gateway routinely emit a tool call whose arguments contain only a prose summary and none of the required payload: `{"description":"Check git status"}` for `bash`, `{"description":"Read the README"}` for `run_code`. The JSON is well formed and the object is closed — the model announces the call and stops generating, at 16–30 completion tokens. `defineTool` rejects it as `INVALID_ARGS`, which is correct: there is nothing to run.

Two things made this expensive rather than merely noisy.

The rejection told the model only which property was missing. Across 107 recorded calls the model recovered on its next attempt 35% of the time and repeated the same stub 64% of the time, in runs of up to eleven consecutive failures, and turns died without an answer.

The repeat-call guard could not see the loop. Its chain key is `(tool name, canonical arguments)`, and `description` was part of those arguments, so one identical command relabelled three ways counted as three unrelated calls. Recorded evidence: three consecutive `find . -name "*.go" -not -path "*/.*" -not -path "./vendor/*" | wc -l` calls under three different labels, with no reminder fired. Stub calls made it worse — each carried different arguments and so reset whatever chain was building.

## Decision

Three changes, none of which pretends to fix the model.

### The rejection tells the model what it already decided

When the only violations are missing required properties and the arguments carry a prose `description` or `title`, `ToolArgsError` appends a directive quoting that summary and naming what is missing: *You described this call as "Check git status" but sent no "command". Issue the same call again now with "command" filled in; the description on its own runs nothing.* Outside that shape the message is the plain violation list, unchanged.

Echoing the model's own summary is the point. The model had already chosen what to do; the violation list alone does not tell it that the choice survived, so it starts over instead of finishing.

### `description` is optional on `bash`, `pwsh`, and `run_code`

The field stays in the schema — it is the card label — but a call carrying the payload alone now runs. The inverse stub is real: the model also emits `code` without `description` and was being rejected for the missing label, which is a failure the harness was inventing for itself. The bash card omits the description slot when absent; the `run_code` card falls back to the program's first non-blank line, mirroring the bash card's use of the command itself.

### The repeat chain compares what a call does

`ignoredArgumentKeys` (default `['description']`) strips presentation-only keys from the chain key, at the top level only, so a relabelled repeat counts as a repeat while a nested `description` stays payload data. Calls whose result carries `INVALID_ARGS` are transparent to the chain: they never ran, and counting them reset the chain that resumes the moment the model completes the call.

## Evidence

Measured live against `gemini-3.7-flash-high` through the same gateway, across all four presets:

| | before | after |
|---|---|---|
| stub recovered on the next call | 35% (n=107) | 68% (21/31) |
| turns reaching an answer | died in runs of up to 11 | 6 of 6 |

Stub emission itself is unchanged, as expected: none of this stops the model producing stubs. `Minimal` mode emitted none at all in 3 calls — its `bash` is `tool-bash-persistent`, whose schema is only `{command}` — but 3 calls prove nothing on their own.

## Consequences

`description` is no longer required on `bash`, `pwsh`, or `run_code`. Any composition that read it as guaranteed must treat it as absent-able: the two shell cards omit the description slot and `run_code` derives its title from the program. Logged calls from before this change still carry the field and replay unchanged.

`ToolArgsError.message` now varies with the arguments for one violation shape. Anything asserting on the exact text of a missing-required-property failure sees the appended directive; `violations` and the `INVALID_ARGS` code are untouched, so policy and routing that read the structured error are unaffected.

The repeat guard counts differently. A deployment that relied on a relabelled repeat resetting the chain now draws reminders sooner, and `ignoredArgumentKeys: []` restores the previous key exactly. A tool whose `description` genuinely changes behavior would be mis-chained by the default and must name itself in `exclude` or clear the key list.

The stub itself still reaches the model as a failed call and still costs an agent step. Making it invisible needs the forced-tool retry recorded under Alternatives.

## Alternatives considered

**Removing `description` from the schema entirely.** Implemented, measured, and reverted. The correlation that motivated it was real — only tools declaring a `description` broke, and `read`/`skill`/`ask_user_question` never did — but the causality was backwards. With the field gone from the schema the model still emitted `description` in 7 of 8 calls and still omitted the payload at the same rate. The habit is the model's, not the schema's. Removing the field would have cost the card label for every model to buy nothing.

**Blaming the gateway's stream aggregation.** Ruled out by replaying one captured request directly against the gateway with `stream: true` and `stream: false`, three times each: stubs appeared at the same rate on both transports. The model closes the JSON early; nothing downstream is dropping deltas.

**An internal retry that forces the tool.** The strongest remaining option and deliberately not taken here: re-requesting with `tool_choice` pinned to the tool would make the stub invisible and cost no agent step. `tool_choice` does not exist anywhere in the LLM seam, so it would mean extending the Service Definition and every provider — a capability-seam change whose only gain over the directive is hiding a card and saving one step, since the model already recovers most of the time. It stays available if the recovery rate proves insufficient.

**Switching models.** Rejected by the deployment: `gemini-3.1-pro` shows the same behavior, so this is a family trait rather than one bad model, and the flash routes are the ones this deployment wants.

**Cutting injected context.** Stub rate correlates with context size in two independent samples — 27.8K vs 16.8K median prompt tokens in the historical data, and the one preset that emitted no stubs is also the one with a ~1K request against ~18K elsewhere. The lever is real but it is a product tradeoff about which tools and documents a preset carries, not a defect, so it is recorded rather than acted on.

**Fuzzy matching in the repeat guard.** Still rejected, as the guard's own note already recorded. Stripping a declared presentation-only field is exact matching on the meaningful arguments; near-identical commands still evade the chain and still need evidence before fuzzy matching earns its cost.

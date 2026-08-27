# Agent Note: Remove `description` from the `subagent` delegation tool

Status: implemented

English | [中文](2026-08-27-subagent-description-removed.zh.md)

## Problem

The `subagent` (and `subagent_fork`) tool kept a required `description` parameter beside its `prompt` payload, while `bash`, `pwsh`, and `run_code` had theirs removed in [2026-08-22](2026-08-22-preamble-only-tool-calls.md). The earlier note deliberately left the dispatch tools alone: their summary was the subagent's own durable creation label, not decoration. That exposed them to the same preamble-only stub the other tools suffered — a Gemini-family model could emit `{"description":"Check the README"}` and stop, and the repair directive was the only cover.

The `description` flowed to three label sites in [packages/subagent/tool-subagent/src/index.ts](../../../packages/subagent/tool-subagent/src/index.ts): `request.label` (passed to `ctx.subagents.start`), `ctx.subagents.startContinuable({label})`, and `jobs.start({label})`. The label becomes the `OneShotSubagentDescriptorData.label` and the `JobSnapshot.label` used by session and job enumeration, so removing the field required a substitute rather than a deletion.

## Decision

Remove `description` from the `subagent` parameter schema and derive the label from `prompt`, mirroring `runCodeTitle(args.code)` in [packages/core/tools/src/code-mode.ts](../../../packages/core/tools/src/code-mode.ts). A new `subagentLabel(prompt, fallback)` helper takes the first non-blank line of `prompt`, elides it at `SUBAGENT_LABEL_MAX_LENGTH` (72, parity with `RUN_CODE_TITLE_MAX_LENGTH`), and falls back to the configured `toolName` when the prompt is whitespace-only. The continuable contract (`startContinuable({label: string})`) stays satisfied because `prompt` is `required: true` and the fallback covers the whitespace-only case the schema does not reject.

The `subagent_fork` tool is the same plugin under a different `toolName`, so the one change covers both.

## Evidence

The `tool-subagent` unit suite covers the derivation: single-line prompts pass through; multi-line prompts use the first non-blank line; long prompts elide with `\u2026`; whitespace-only and empty prompts fall back to `toolName`. The capture-provider test asserts `request.label` equals the derived value across all cases. The schema-key tests confirm the model-visible parameters are now `['prompt', 'run_in_background']` (or `['prompt']` when background is disabled).

The keyless snapshot suite (`pnpm run test:snapshot`) refreshed every `subagent/descriptor` label and every `tool-schemas` block across the ACP, headless, and JSON-RPC example trees; the only diff in each is the removed `description` parameter and the label switching from the model-authored summary to the derived prompt line.

## Consequences

`description` no longer exists on `subagent` or `subagent_fork`. A composition that read it is reading a field no call carries: the tool derives `label` from `prompt` instead. Logged calls from before this change still carry the field; presentation ignores it and replay is unaffected, matching the [2026-08-22](2026-08-22-preamble-only-tool-calls.md) shell/code-call precedent.

The transcript loses the model-authored one-line summary on dispatch calls. What a reader sees in session and job lists is the first line of the task prompt, which is more literal and less curated than the summary was. The continuable descriptor's durable creation label is now derived rather than model-authored; cold resume and enumeration are unaffected because the label remains a non-empty string.

`ToolArgsError.message` and the repeat-chain `ignoredArgumentKeys` default are unchanged: `description` is already in the default ignore list, and with the field gone from the schema the chain key is just the payload.

## Alternatives considered

**A fixed fallback label (e.g. `"subagent"`).** Rejected: it loses distinction between children in session and job lists, and the prompt-derived label preserves that distinction at near-zero cost.

**Making `label` optional everywhere.** Rejected: the continuable descriptor and `startContinuable` contract require a non-empty `label`, so dropping the requirement would mean a contract change and a fallback at the service boundary rather than at the tool layer. Deriving at the tool layer keeps the service contract intact.

**Renaming `description` to `label` as an explicit parameter.** Rejected for the same reason the 2026-08-22 note rejected optional `description`: a field the model can see is a field it will fill, and filling it is where it stops. The stub moves rather than disappears.

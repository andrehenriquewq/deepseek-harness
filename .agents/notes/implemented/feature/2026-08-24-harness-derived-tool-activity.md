# Agent Note: Harness-derived tool activity

Status: implemented

English | [中文](2026-08-24-harness-derived-tool-activity.zh.md)

## Problem

Removing the model-authored `description` from `bash`, `pwsh`, and `run_code` stopped Gemini-family models from announcing a call and then failing to issue it ([preamble-only calls](../bug-fix/2026-08-22-preamble-only-tool-calls.md)). It also removed the only sentence the UI had about what a `run_code` program was doing. A running program showed the first line of its own source and nothing more, however many tools it went on to call.

The material to say more was already logged and already presentable, and none of it needed the model. Every sub-dispatch appends `tool/code-dispatch-start` and `tool/code-dispatch` carrying the tool `name` and the JSON-normalized `arguments` the bridge dispatched, and most tools already declare a pure `presentCall`/`presentResult` that turns exactly those arguments into a card ([render-intent union](../architecture/2026-07-02-tool-render-intent-union.md)). The host computed those views for `tool/call` and `tool/result` only, so a sub-call arrived at the client with `callView: null` and `resultView: null` — no read window, no diff, no terminal card, no declared label — and the parent had nothing to report.

## Decision

Presentation is derived from the call, at the same seam that already derives it for a native call.

`viewFor` in [`dsh-host-apiproxy`](../../../../packages/host/apiproxy/src/api-proxy.ts) resolves a `ToolEventView` for two more event types. `tool/code-dispatch-start` runs the named tool's `presentCall` over the event's own `arguments`; `tool/code-dispatch` runs `presentResult` over the same arguments plus the settled `content`/`isError`. Neither needs the call/result pairing a native `tool/result` needs, because both events carry the arguments. The existing soft-fall covers every miss: no presenter, no view; a throwing presenter, no view; and the client's documented generic card handles it.

Both Conversation Node definitions that fold the dispatch pair — [chat](../../../../packages/client/ui-conversation/src/client/conversation-nodes/tool.ts) and [trajectory](../../../../packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts) — read `match.view` for a child call exactly as they already did for a root call, and a child's settle keeps the pending `callView` the way a root's does.

Two derivations in [`dsh-client-ui-tool`](../../../../packages/client/ui-tool/src/client/tool/models/tool-call-model.ts) turn that into row text. An unclassified row takes its summary from the tool's declared call-view title instead of the wire name plus a raw argument; a classified row keeps its args-derived summary, which already names the specific value its title and icon do not. `subCallActivity` reports a running parent by its newest unsettled child, labelled by that child's declared view or, failing that, by the args-derived summary the child's own row shows. A parent with no children, and every settled parent, keep their own summary.

The model's contract is unchanged and stays minimal: `run_code` takes `code`, `bash` and `pwsh` take a command and executor options. No presentation-only property may be added back — [the schema tests](../../../../packages/core/tools/tests/code-mode.spec.ts) pin each property list exactly, so a UI-serving field fails before it can reach a model.

## The sub-dispatch settle carries no result metadata

`tool/code-dispatch` logs the sub-call's model-facing outcome (`content` + `isError`) and no `meta`. A presenter that projects its card from result metadata — `grep`/`glob`'s search card, `read`'s line window — therefore returns nothing for a sub-call, which falls back to the generic body carrying the same text. The call view is the one that always applies, and it is the one that carries the activity label.

Threading `meta` into the dispatch log would put a tool-private presentation payload into a durable event for a UI's benefit, on the log that already spills large sub-call content. The call side already answers the question the regression was about.

## Alternatives considered

**Put the presentation into the `tool/code-dispatch-start` payload.** The dispatch events are durable session log; a render intent is not. Views are recomputed from the presenters registered at delivery time and deliberately never persisted, so the same event may carry a different view (or none) on a later delivery, and a UI redesign costs no format change. Logging one would freeze today's cards into every session file and bump `SESSION_FORMAT_VERSION` for a display concern.

**Derive friendly prose in the UI from tool names and arguments.** A table mapping `pnpm test` to "Running the tests" is a second presentation implementation, in one hardcoded language, living where the tools cannot maintain it — and it would answer differently from the tool's own card for the same call. The tools already own `presentCall`; the gap was that nothing ran it for a sub-call.

**Replace `description` with an optional summary field under another name.** Measured behavior rejects this: a field the model can see is a field it will fill, and filling it is where Gemini-family models stopped. Optional was already tried and was not enough ([preamble-only calls](../bug-fix/2026-08-22-preamble-only-tool-calls.md)).

**Ask a second model to caption the call.** A network round trip and a token bill for a row label, on a surface that must also render during a session-log replay with no model attached. Presenters are pure functions of arguments precisely so replay and live streaming agree.

## Consequences

A `run_code` program now renders like the tool calls it makes: each sub-call draws its own tool's card, and the parent row reports the current one. Every provider gains this equally — nothing in the path is Gemini-specific; the only provider-driven constraint is the minimal schema, which every model benefits from.

Tools with no presenter are unaffected and still render the generic row, and a tool that declares a call view now sees its title on an unclassified row where the raw tool name used to be. Sub-calls of `grep`, `glob`, and `read` show their generic bodies rather than their result cards until the dispatch log carries result metadata.

Execution is untouched: no change to the sandbox, the code runtime, dispatch, permissions, retries, tool results, or argument serialization. The added work is one presenter call per dispatch event on the delivery path, inside the existing try/catch.

## Testing

[The host view suite](../../../../packages/host/apiproxy/tests/api-proxy-view.spec.ts) covers a sub-dispatch pair reaching its tool's card, a presenterless sub-tool shipping no view, and a throwing presenter soft-falling without costing the event. The two Conversation Node suites cover a child taking its own view and keeping it across its settle. [The row-model suite](../../../../packages/client/ui-tool/tests/tool-row.client.spec.tsx) covers declared-title precedence, the blank/absent-title fallbacks, and every `subCallActivity` case, plus a rendered `run_code` row switching from its program's first line to its child's label. The `run_code`, `bash`, and `pwsh` schema tests pin the exact property lists as the regression guard.

The offline `?fixture` client mirrors the call side only: its result presenters answer by tool name with authored sample payloads that describe their own turns' files, not whatever a sub-call touched.

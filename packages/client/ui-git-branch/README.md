# @deepseek-ai/dsh-client-ui-git-branch

English | [中文](README.zh.md)

Browser-half plugin rendering the session header's Git branch chip: the branch of the directory the displayed session's work lands on. It registers into the existing `conversation.session.header.actions` list slot (`id: 'git-branch'`, `order: -12`) beside the agent-preset label — no slot contract changes, no new seats.

State comes from [`@deepseek-ai/dsh-client-runtime`](../runtime/README.md)'s `ctx.gitState`, which mirrors Host-pushed `host/git-state-changed` frames keyed by each live session's cwd. This plugin is a pure reader: it selects one entry by the session's own cwd and renders, so concurrent sessions in different repositories each show their own branch and updates arrive without user action.

## Behavior

- **Absent means absent** — every non-branch state (no repository, unreadable, still resolving, session without a cwd) renders nothing at all: no skeleton, no reserved width, no console noise. The common non-repository workspace lays out exactly as a deployment without the plugin.
- **Distinguishable markers** — the chip carries a branch glyph that the client build-revision badge lacks, including for branches literally named like commit identifiers; a detached HEAD additionally shows an uppercase "Detached HEAD" mark and a dashed border.
- **Readable under pressure** — over-long names truncate with CSS ellipsis; the native `title` exposes the full name on hover and keyboard focus.
- **Non-interactive by design** — no activation affordance, no click action, no button semantics.

## Known Limitations and Deferred Work

- **Tracked paths only** — only directories reported as some live session's cwd appear in the shared state map; arbitrary path pickers would need their own Consumer over the same runtime domain.
- **No manual refresh** — currency follows the Host's watch/poll cadence; a pull-to-refresh affordance is deferred until a workflow asks for it.

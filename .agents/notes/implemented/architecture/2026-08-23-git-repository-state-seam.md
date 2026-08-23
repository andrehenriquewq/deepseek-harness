# Agent Note: Git repository-state seam and the session-header branch chip

Status: implemented

English | [中文](2026-08-23-git-repository-state-seam.zh.md)

## Problem

The agent creates and switches Git branches mid-session while the user watches, and nothing on screen names the branch the work is landing on. The only VCS-looking element in the UI is `DSH_CLIENT_COMMIT_HASH` — the client build's own commit, constant across sessions — which invites exactly the wrong inference. Meanwhile several sidebar sessions may sit in different repositories, and answering "which branch is this?" requires leaving the app.

Any fix had to clear three bars at once: correctness on the layouts a real workspace hits (linked worktrees, packed refs, detached HEAD), observation cost bounded by distinct repositories rather than open sessions, and a remote Host working by construction because the browser cannot touch the filesystem.

## Decision

A new capability seam owns the answer to "what branch is this path on", split into the standard three roles:

- **Service Definition** — [`@deepseek-ai/dsh-git-state`](../../../../packages/git/git-state) declares `ctx.gitState`: `resolve(request): Spec`, `run(spec)`, and `attach(spec, observer)` returning a disposer. Every resolution yields exactly one of four tags — `named-branch`, `detached`, `no-repository`, `unavailable` — so closed-union switches end in `assertNever`. The seam never throws to callers and never writes to the target repository.
- **Provider** — [`@deepseek-ai/dsh-git-state-local`](../../../../packages/git/git-state-local) delegates every question to the `git` binary through `ctx.subprocess` (`rev-parse --git-dir`, `--abbrev-ref HEAD`, `--short HEAD`). Repository discovery runs before HEAD resolution so corrupt metadata (discovery fails with a local `.git` entry present) reports `unavailable` instead of collapsing into `no-repository`. Observation entries key on the resolved Git common directory with reference counting; each entry watches its worktree's git-dir **directory** — not the `HEAD` file, whose atomic rename replacement silently starves file watches on macOS. Watch registration is fallible: any throw or runtime error degrades that repository alone to interval re-resolution. Watch debounce and fallback poll interval are validated `Config` fields.
- **Consumers** — the apiproxy domain (`gitState.resolve`) plus host-level tracking of live session cwds pushes `host/git-state-changed` frames; [`@deepseek-ai/dsh-client-runtime`](../../../../packages/client/runtime) mirrors them into a path-keyed store seeded by unary resolves; [`@deepseek-ai/dsh-client-ui-git-branch`](../../../../packages/client/ui-git-branch) registers a read-only chip into the existing `conversation.session.header.actions` slot (`order: -12`, beside the agent-preset label).

Product rules worth restating: the chip renders nothing for every non-branch state — including before first resolution — without reserving width; detached HEADs carry an uppercase mark plus dashed border so they stay distinguishable from a branch literally named like the build badge; branch text never enters a model request or the session log (no `SessionEventMap` member, no format bump).

## Alternatives considered

- **Parse `.git/HEAD` directly.** Fastest path, no subprocess. Rejected: it re-implements worktree and commondir resolution, and a wrong branch is worse than no branch for a trust indicator.
- **Poll `git rev-parse` on an interval, no watching.** Simplest and sandbox-proof. Rejected as the primary mechanism: a poll slow enough to be cheap is slow enough that the chip lags the agent's own `checkout` — the motivating case. Retained as the per-repository fallback where watching fails.
- **A Git library dependency.** Rejected: every candidate pulls a full object-store implementation to answer one question the `git` binary answers in milliseconds.
- **Per-session watchers on the Host.** Simpler bookkeeping, but with several sessions in one working tree it holds N watchers reporting the same change N times. Reference-counting by common directory bounds cost by distinct repositories instead.
- **Push branch state over the per-session mux stream.** Would force the Host to fan one filesystem event out into per-session frames and re-report identical state to every session sharing a repository. A host-level frame keyed by path lets each consumer select the entry it cares about.

## Consequences

The wire gained one additive RPC method and one host frame; rollback is unmounting three bundle rows. A remote Host without the domain degrades to the unavailable state rather than a connection error, which the client maps onto the same silent-absent rendering. Watching now uses recursive FSEvents on macOS with a flat-watch fallback elsewhere, and watcher creation happens off the cordis event stack — both hard-won details live in `startWatch`/`ensureWatch` and their tests. What was knowingly given up: repository creation in a PARENT of the observed path is invisible until another event or poll fires, and a dangling `.git` pointer classifies as corruption (`unavailable`) rather than absence; neither state fabricates a branch name.

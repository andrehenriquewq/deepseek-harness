# git/ — Git repository-state capability family

English | [中文](README.zh.md)

The capability family answers "which branch is this directory on?" for any Host-reachable path and reports changes while observed, without mutating the repository. Both packages are **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`git-state/`](git-state/README.md) | Defines the determinate state vocabulary shared by Service Providers and Consumers. | `ctx.gitState` |
| [`git-state-local/`](git-state-local/README.md) | Resolves through the local `git` binary and watches repository metadata for changes. | (registers `ctx.gitState`) |

Resolution delegates to Git itself — never to hand-parsed `.git` files — so linked worktrees, packed refs, and commondir indirection resolve correctly. Observation is reference-counted per resolved repository, so concurrent callers on one working tree share one watcher.

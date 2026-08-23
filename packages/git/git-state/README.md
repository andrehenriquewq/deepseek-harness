# @deepseek-ai/dsh-git-state

English | [中文](README.zh.md)

Service Definition for the Git repository-state capability seam (`ctx.gitState`): resolving which branch — or branch absence — a directory path is on, and reporting changes to that answer while a caller holds an observation. The seam owns the four-state determinate vocabulary (`named-branch` / `detached` / `no-repository` / `unavailable`), the request/spec split (`resolve()` applies every default; `run()`/`attach()` take only resolved specs), and the read-only guarantee. Git mechanics and watching strategy belong to the provider; the local implementation lives in [`@deepseek-ai/dsh-git-state-local`](../git-state-local/README.md).

The package root exports the default and named `GitStateService` class plus the state/request vocabulary from `./types`.

## Behavior

- **Exactly one determinate state per resolution** — every path resolves to `named-branch`, `detached`, `no-repository`, or `unavailable`; there is no ambiguous result, so closed-union switches can end in `assertNever`.
- **Never throws at callers** — missing paths, unreadable directories, unusable git binaries, and corrupt repository metadata all resolve to `unavailable` with a diagnostic reason; observers are invoked asynchronously and never re-entrantly.
- **Observation is bounded and released** — `attach()` returns an idempotent disposer that frees every Host resource the observation acquired; Host shutdown releases still-outstanding observations without blocking shutdown.

## Known Limitations and Deferred Work

- **Branch identity only** — dirty state, ahead/behind counts, stash, and conflict indicators are out of scope for this seam.
- **No write path** — checkout, branch creation, or a branch picker would be separate Consumers with their own safety story; this seam is read-only by contract.

# @deepseek-ai/dsh-git-state-local

English | [中文](README.zh.md)

Local Service Provider for the [`@deepseek-ai/dsh-git-state`](../git-state/README.md) seam over the [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) service: `LocalGitStateService` asks the local `git` binary (`rev-parse --git-dir`, `--abbrev-ref HEAD`, `--short HEAD`) instead of parsing `.git` by hand, so linked worktrees, packed refs, and commondir indirection resolve correctly. Change detection watches repository metadata and falls back to interval re-resolution where watching is unavailable. Resolution and observation never write to the target repository.

The package root exports the default and named `LocalGitStateService` plugin plus its `Config`.

## Config

```yaml
- id: git-state
  name: '@deepseek-ai/dsh-git-state-local'
  config:
    watchDebounceMs: 150    # coalesces filesystem events before one re-resolution pass
    pollIntervalMs: 5000    # fallback re-resolution interval where watching is unavailable
```

## Behavior

- **Resolution delegates to Git** — discovery (`--git-dir`) runs before HEAD resolution so a plain non-repository stays distinguishable from corrupt metadata: discovery that fails with a local `.git` entry present reports `unavailable`, not `no-repository`. A detached checkout is tagged `detached` with an abbreviated commit; callers never parse identifiers to distinguish states.
- **Watching keys on the resolved repository, not the caller** — observations share one entry per Git common directory (reference-counted across callers), each entry watching its worktree's git-dir directory. Watching the directory rather than the `HEAD` file matters: Git replaces `HEAD` atomically via rename, which silently detaches file-targeted watches on some platforms. While no repository exists at the observed path, the entry watches the path itself so a later `git init` there is seen.
- **Degradation over silence** — watch registration may throw (sandboxed deployments) and live watches may fail; either degrades that repository only to interval re-resolution at `pollIntervalMs`. Other repositories keep event-driven updates. Every filesystem burst is debounced to one re-resolution pass (`watchDebounceMs`), since Git writes metadata more than once per operation.
- **Read-only guarantee** — resolution spawns only `rev-parse` (a read-only porcelain query); observation adds filesystem watching. Nothing in a full observation lifecycle creates or modifies refs, index entries, lock files, configuration, or working-tree content — proven byte-for-byte by tests over real repositories.
- **Shutdown without blocking** — teardown closes watchers and clears timers synchronously; in-flight continuations that resume after composition disposal map onto the unavailable state instead of throwing across teardown.

## Known Limitations and Deferred Work

- **Repository creation is seen only at the observed directory** — a `git init` in a parent of the observed path is invisible until some other event or poll re-resolves; the spec'd transition covers initialization at the tracked directory itself.
- **A dangling `.git` pointer reads as corruption** — a `.git` file whose recorded gitdir is missing reports `unavailable` rather than `no-repository`; both are determinate and neither fabricates a branch name.
- **Fixed operational bounds** — the per-invocation deadline (10s), kill grace (1s), and collected-output caps are constants, not config: they bound pathology of a milliseconds-scale read-only query, not deployment latency.

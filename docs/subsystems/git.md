# Git Repository State

English | [中文](git.zh.md)

The repository-state seam answers "which branch is this directory on?" for any Host-reachable path and reports changes while observed, without mutating the repository. It is split across a Service Definition ([dsh-git-state](../../packages/git/git-state), `ctx.gitState`), a Service Provider ([dsh-git-state-local](../../packages/git/git-state-local)), and Consumers such as the session-header branch chip. Resolution delegates to the `git` binary through the [subprocess seam](subprocess.md); nothing here parses `.git` by hand.

Source: [`packages/git/git-state/src/types.ts`](../../packages/git/git-state/src/types.ts)

## The four determinate states

Every resolution produces exactly one state — there is no ambiguous or unresolved result, so closed-union switches end in `assertNever`. Callers distinguish states by tag and never parse identifiers: a detached checkout is tagged `detached` even though its abbreviated commit text may look like a branch name.

```ts type-equiv
/**
 * One determinate resolution of a directory path. Every resolution produces
 * exactly one member — there is no unresolved or ambiguous result — so
 * closed-union switches can end in `assertNever`.
 */
type GitRepositoryState =
  | GitNamedBranch
  | GitDetachedHead
  | GitNoRepository
  | GitUnavailable
```

```ts type-equiv
/** The path resolves to a repository checked out on a named branch. */
interface GitNamedBranch {
  type: 'named-branch'
  /** Branch name exactly as `git rev-parse --abbrev-ref HEAD` reports it. */
  branch: string
}
```

```ts type-equiv
/** The path resolves to a repository with a detached HEAD. */
interface GitDetachedHead {
  type: 'detached'
  /** Abbreviated commit identifier as `git rev-parse --short HEAD` reports it. */
  commit: string
}
```

```ts type-equiv
/** The path exists but no Git working tree contains it. */
interface GitNoRepository {
  type: 'no-repository'
}
```

```ts type-equiv
/**
 * The path cannot be resolved to any determinate state: missing, not a
 * directory, unreadable, or corrupt/uninterpretable repository metadata.
 * `reason` is a diagnostic for logs and support, never user-facing copy.
 */
interface GitUnavailable {
  type: 'unavailable'
  reason: string
}
```

## Request vs. spec: the `resolve()` split

Following the repo's explicit-over-implicit rule, callers hand a request to `resolve()` and pass the returned spec to `run()`/`attach()`. Today the split carries one normalization (relative paths become absolute); the shape exists so future defaulting lands in one reviewed place instead of inside providers.

```ts type-equiv
/** A caller's resolution request. */
interface GitStateRequest {
  /**
   * Directory whose branch state is wanted. Relative paths are resolved
   * against the provider's working directory by {@link resolve}.
   */
  path: string
}
```

```ts type-equiv
/** A fully-specified resolution target; every default has been applied. */
interface GitStateSpec {
  /** Absolute directory path; never relative. */
  path: string
}
```


## Observation contract

`attach(spec, observer)` reports the current state shortly after attach and every transition to a DIFFERENT resolved state — covering changes made by any process, including the agent's own commands — until release. Providers must:

- key shared resources by resolved Git common directory with reference counting, so callers observing one working tree share one watcher;
- suppress notifications when re-resolution yields the already-reported state;
- degrade to interval re-resolution per repository where watching is unavailable;
- release every Host resource on disposer or Host shutdown, without blocking shutdown.

Resolution and observation are read-only with respect to the target: no refs, index entries, lock files, configuration, or working-tree content may be created, modified, or removed.

## Wire projection

The client reaches the seam over the apiproxy: a unary `gitState.resolve` plus the host-level `host/git-state-changed` frame (`{ path, state }`). The frame's path is the same absolute cwd clients already receive in session frames, so it discloses no new class of information. The wire union mirrors the four tags above structurally; see [dsh-host-apiproxy](../../packages/host/apiproxy) (`api/git-state.ts`).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgitstate--gitstateservice-abstract-seam"></a>

### `ctx.gitState` — `GitStateService` (abstract seam)

Abstract Git repository-state service. Subclass, implement the abstract methods, and load the subclass as a plugin — it registers as `ctx.gitState` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Resolution and observation are READ-ONLY with respect to the target: no refs, index entries, lock files, configuration, or working-tree content may be created, modified, or removed.
- Neither run nor an observer callback ever throws to the caller; every failure mode resolves to GitUnavailable with a diagnostic reason.
- attach reports each transition to a different resolved state for as long as the observation is held, covering changes made by any process.
- Releasing the disposer returned by attach frees every Host resource that observation acquired; Host shutdown releases every still-outstanding observation without blocking shutdown.

```ts cordis-catalog
/**
 * Apply implementation-owned defaults to a request before use.
 * @param request - the caller's request.
 * @returns the fully-specified spec to hand to {@link run}/{@link attach},
 *   never a raw request.
 */
abstract resolve(request: GitStateRequest): GitStateSpec

/**
 * Resolve one path to its current state.
 * @param spec - a resolved spec from {@link resolve}, never a raw request.
 * @returns exactly one determinate state; never rejects.
 */
abstract run(spec: GitStateSpec): Promise<GitRepositoryState>

/**
 * Observe one path until release. The observer receives the current state
 * shortly after attach and every later transition to a different state.
 * @param spec - a resolved spec from {@link resolve}, never a raw request.
 * @param observer - invoked asynchronously per reported state.
 * @returns the disposer releasing this observation and every Host resource
 *   it acquired. Idempotent.
 */
abstract attach(spec: GitStateSpec, observer: GitStateObserver): () => void
```

Source: [`packages/git/git-state/src/index.ts`](../../packages/git/git-state/src/index.ts)
<!-- END GENERATED cordis-surface -->

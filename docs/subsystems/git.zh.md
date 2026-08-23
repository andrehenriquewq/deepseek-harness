# Git 仓库状态

[English](git.md) | 中文

仓库状态 seam 回答"这个目录当前在哪个分支"，覆盖宿主可达的任意路径，并在被观察期间报告变化，且绝不改动仓库。它拆分为 Service Definition（[dsh-git-state](../../packages/git/git-state)，`ctx.gitState`）、Service Provider（[dsh-git-state-local](../../packages/git/git-state-local)）与 Consumer（如会话头部分支 chip）。解析通过[子进程 seam](subprocess.zh.md) 委托给 `git` 二进制；这里没有任何手工解析 `.git` 的逻辑。

来源：[`packages/git/git-state/src/types.ts`](../../packages/git/git-state/src/types.ts)

## 四个确定状态

每次解析恰好产生一个状态 —— 没有歧义或未解析的结果，封闭联合的 switch 以 `assertNever` 收尾。调用者靠标签区分状态，从不解析标识符：分离检出即使其缩写提交号看起来像分支名，也会打上 `detached` 标签。

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

## 请求 vs 规格：`resolve()` 拆分

遵循仓库"显式优先于隐式"的规则，调用者把请求交给 `resolve()`，再把返回的规格传给 `run()` / `attach()`。当前该拆分只承载一种规范化（相对路径转绝对）；这一形状的存在是为了让未来的默认值落在唯一一处受评审的位置，而不是散落在各提供方内部。

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


## 观察契约

`attach(spec, observer)` 在 attach 后很快报告当前状态，并在其后的每一次"解析到不同状态"的转换时报告 —— 覆盖任何进程的改动，包括 agent 自己的命令 —— 直到释放为止。Provider 必须：

- 以解析出的 Git common directory 为键共享资源并做引用计数，观察同一工作树的调用者共享一个 watcher；
- 重解析结果与已报告状态相同时抑制通知；
- 在监听不可用处按仓库退化为间隔重解析；
- 在 disposer 或宿主关机时释放所有宿主资源，且不阻塞关机。

解析与观察对目标仓库只读：不得创建、修改或删除任何 ref、index 条目、锁文件、配置或工作树内容。

## 线上投影

客户端经 apiproxy 访问本 seam：一个一元 `gitState.resolve` 加上宿主级 `host/git-state-changed` 帧（`{ path, state }`）。帧中的 path 与客户端已在 session 帧中收到的绝对 cwd 相同，因此没有披露新的信息类别。线上联合与上述四标签结构镜像；见 [dsh-host-apiproxy](../../packages/host/apiproxy)（`api/git-state.ts`）。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

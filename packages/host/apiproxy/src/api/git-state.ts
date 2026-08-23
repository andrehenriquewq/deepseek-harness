/**
 * gitState domain contract: resolving one absolute directory path to its
 * current Git repository state. Method signatures are the source of truth.
 * Live updates ride `host/git-state-changed` host frames, so this domain is
 * unary-only; its state union mirrors @deepseek-ai/dsh-git-state's vocabulary,
 * re-declared here rather than imported because api/ must stay
 * browser-importable with zero host-package dependencies.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** The path resolves to a repository checked out on a named branch. */
export interface GitNamedBranch {
  type: 'named-branch'
  /** Branch name exactly as Git reports it. */
  branch: string
}

/** The path resolves to a repository with a detached HEAD. */
export interface GitDetachedHead {
  type: 'detached'
  /** Abbreviated commit identifier as Git reports it. */
  commit: string
}

/** The path exists but no Git working tree contains it. */
export interface GitNoRepository {
  type: 'no-repository'
}

/**
 * The path cannot be resolved to any determinate state. `reason` is a
 * diagnostic for logs and support, never user-facing copy.
 */
export interface GitUnavailable {
  type: 'unavailable'
  reason: string
}

/** One determinate resolution of a directory path (the four-tag closed union). */
export type GitRepositoryState =
  | GitNamedBranch
  | GitDetachedHead
  | GitNoRepository
  | GitUnavailable

/** Git-state-domain unary methods (the map keys gitState.* of RpcMethodMap). */
export interface GitStateApi {
  /**
   * Resolves one absolute directory path to its current state. Never fails:
   * every outcome — including an unmounted capability or an unreadable path —
   * is one of the four determinate states, so callers never catch here.
   * Resolution is read-only with respect to the target repository.
   */
  resolve(request: RpcRequest<{ path: string }>): Promise<RpcResponse<{ state: GitRepositoryState }>>
}

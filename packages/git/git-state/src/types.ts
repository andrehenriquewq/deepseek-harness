/**
 * Vocabulary for the Git repository-state Service Definition: the four
 * determinate resolutions of one directory path, the request/spec pair, and
 * the observation callback. Git mechanics and watching strategy belong to
 * providers; consumers only see these values.
 * @module dsh-git-state/types
 */

/** The path resolves to a repository checked out on a named branch. */
export interface GitNamedBranch {
  type: 'named-branch'
  /** Branch name exactly as `git rev-parse --abbrev-ref HEAD` reports it. */
  branch: string
}

/** The path resolves to a repository with a detached HEAD. */
export interface GitDetachedHead {
  type: 'detached'
  /** Abbreviated commit identifier as `git rev-parse --short HEAD` reports it. */
  commit: string
}

/** The path exists but no Git working tree contains it. */
export interface GitNoRepository {
  type: 'no-repository'
}

/**
 * The path cannot be resolved to any determinate state: missing, not a
 * directory, unreadable, or corrupt/uninterpretable repository metadata.
 * `reason` is a diagnostic for logs and support, never user-facing copy.
 */
export interface GitUnavailable {
  type: 'unavailable'
  reason: string
}

/**
 * One determinate resolution of a directory path. Every resolution produces
 * exactly one member — there is no unresolved or ambiguous result — so
 * closed-union switches can end in `assertNever`.
 */
export type GitRepositoryState =
  | GitNamedBranch
  | GitDetachedHead
  | GitNoRepository
  | GitUnavailable

/** A caller's resolution request. */
export interface GitStateRequest {
  /**
   * Directory whose branch state is wanted. Relative paths are resolved
   * against the provider's working directory by {@link resolve}.
   */
  path: string
}

/** A fully-specified resolution target; every default has been applied. */
export interface GitStateSpec {
  /** Absolute directory path; never relative. */
  path: string
}

/**
 * Receives the current state once shortly after attach, then every
 * transition to a DIFFERENT resolved state. Invoked asynchronously, never
 * re-entrantly from attach; repeated resolutions yielding an equal state do
 * not invoke it again.
 */
export type GitStateObserver = (state: GitRepositoryState) => void

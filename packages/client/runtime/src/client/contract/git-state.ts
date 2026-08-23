/**
 * The outward git-state-service face — what `ctx.gitState` exposes to feature
 * packages, and therefore exactly what the test runtime's git-state double
 * must implement. Wire-pump entry points (handleHostEnvelope/handleConnected)
 * and the session-lifecycle reconcile stay on the concrete class. Widening
 * this interface is the explicit act of widening what features may do with
 * repository state.
 */
import type { GitRepositoryState, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from './store.ts'

/** Immutable path-keyed snapshot of resolved Git repository states. */
export interface GitStateSnapshot {
  /**
   * Resolved state per tracked absolute path. Only paths some live session
   * reports as its cwd appear; an entry exists before first resolution only
   * as the unavailable placeholder a failed seed installs.
   */
  entries: Readonly<Record<string, GitRepositoryState>>
}

/** The git-state-service face injected as `ctx.gitState`. */
export interface IGitState {
  /** The useGitState standard feed (read-only — observation is Host-owned). */
  readonly states: ObservableSnapshot<GitStateSnapshot>
  /**
   * Resolve one session's branch state from its cwd.
   * @param sessionId - the displayed session.
   * @returns its current state, or undefined when the session has no cwd or
   *   its path has not resolved yet — both render as "no branch".
   */
  stateForSession(sessionId: SessionId): GitRepositoryState | undefined
}

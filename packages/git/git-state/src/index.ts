/**
 * Service Definition for the Git repository-state capability seam
 * (`ctx.gitState`): resolving which branch (or branch absence) a directory
 * path is on, and reporting changes to that answer while a caller holds an
 * observation. Git mechanics, watching, and polling strategy belong to
 * providers; this seam owns the determinate-state vocabulary and the
 * read-only guarantee. The local implementation lives in
 * `@deepseek-ai/dsh-git-state-local`.
 * @module @deepseek-ai/dsh-git-state
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { GitRepositoryState, GitStateObserver, GitStateRequest, GitStateSpec } from './types.ts'

export type {
  GitDetachedHead,
  GitNamedBranch,
  GitNoRepository,
  GitRepositoryState,
  GitStateObserver,
  GitStateRequest,
  GitStateSpec,
  GitUnavailable,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gitState: GitStateService
  }
}

/**
 * Abstract Git repository-state service. Subclass, implement the abstract
 * methods, and load the subclass as a plugin — it registers as `ctx.gitState`
 * (one implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Resolution and observation are READ-ONLY with respect to the target:
 *   no refs, index entries, lock files, configuration, or working-tree
 *   content may be created, modified, or removed.
 * - Neither {@link run} nor an observer callback ever throws to the caller;
 *   every failure mode resolves to {@link GitUnavailable} with a diagnostic
 *   reason.
 * - {@link attach} reports each transition to a different resolved state for
 *   as long as the observation is held, covering changes made by any process.
 * - Releasing the disposer returned by {@link attach} frees every Host
 *   resource that observation acquired; Host shutdown releases every
 *   still-outstanding observation without blocking shutdown.
 */
export abstract class GitStateService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'gitState')
  }

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
}

export default GitStateService

/** GitStateRuntime projects the repository-state manager for UI consumers. */

import type { Context } from '@deepseek-ai/cordis'
import type { GitRepositoryState, IApiClient, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { SessionsPort } from '../contract/sessions-port.ts'
import type { GitStateSnapshot, IGitState } from '../contract/git-state.ts'
import { GitStateManager } from './manager.ts'

/**
 * Real repository-state object layer. The Host owns observation (it tracks
 * live sessions' cwd values and pushes `host/git-state-changed` frames); this
 * runtime mirrors the path-keyed map, seeds each session cwd once through the
 * unary resolve, and releases paths no session reports anymore — so no entry
 * outlives its sessions.
 */
export class GitStateRuntime implements IGitState {
  /** UI-facing immutable projection; the manager remains wire truth. */
  readonly states: SnapshotStore<GitStateSnapshot>
  private readonly manager: GitStateManager
  private readonly sessions: SessionsPort

  /**
   * @param ctx - client root context.
   * @param api - shared wire client.
   * @param sessions - cross-domain sessions face; its list drives which cwds
   *   are tracked (seed on appear, release when the last accounting session
   *   closes).
   */
  constructor(ctx: Context, api: IApiClient, sessions: SessionsPort) {
    this.sessions = sessions
    this.manager = new GitStateManager(api)
    this.states = createSnapshotStore<GitStateSnapshot>({ entries: {} })
    this.manager.subscribe(() => { this.project() })
    // Session list changes drive attach/release: a cwd entering the list is
    // seeded immediately (the chip shows state before any frame arrives), and
    // a path losing its last session drops its entry.
    sessions.list.subscribe(() => { this.reconcile() })
    ctx.reflect.provide('gitState', this, undefined)
    // Sessions listed before construction (a reconnect or a hot reload) are
    // tracked by the same one rule, not a special first pass.
    this.reconcile()
  }

  /**
   * Resolve one session's branch state from its cwd.
   * @param sessionId - the displayed session.
   * @returns its current state, or undefined when the session has no cwd or
   *   its path has not resolved yet — both render as "no branch".
   */
  stateForSession(sessionId: SessionId): GitRepositoryState | undefined {
    const cwd = this.sessions.list.getSnapshot().byId[sessionId]?.cwd
    if (cwd === undefined) return undefined
    return this.states.getSnapshot().entries[cwd]
  }

  /**
   * Route a Host stream envelope into the object layer.
   * @param envelope - validated Host stream envelope.
   */
  handleHostEnvelope(envelope: Parameters<GitStateManager['handleHostEnvelope']>[0]): void {
    this.manager.handleHostEnvelope(envelope)
  }

  /** Re-seed every tracked path after reconnection: offline frames are lost. */
  handleConnected(): void {
    this.manager.handleConnected()
    this.reconcile()
  }

  private reconcile(): void {
    const { ids, byId } = this.sessions.list.getSnapshot()
    const wanted = new Set<string>()
    for (const id of ids) {
      const cwd = byId[id]?.cwd
      if (cwd !== undefined) wanted.add(cwd)
    }
    for (const path of wanted) this.manager.seed(path)
    this.manager.retainOnly(wanted)
  }

  private project(): void {
    this.states.set(this.manager.getSnapshot())
  }
}

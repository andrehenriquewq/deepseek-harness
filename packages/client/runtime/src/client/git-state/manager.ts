/** Git repository-state baseline, host-frame, and seed owner. */

import type {
  GitRepositoryState, HostFrame, IApiClient, RpcRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import { gitRepositoryStatesEqual as statesEqual } from '@deepseek-ai/dsh-host-apiproxy/api'
import { Notifier } from '../sessions/notifier.ts'
import type { GitStateSnapshot } from '../contract/git-state.ts'

/** Path-keyed state cluster driven by seeds and `host/git-state-changed` frames. */
export class GitStateManager {
  private entries: Readonly<Record<string, GitRepositoryState>> = {}
  /** Paths with an in-flight or completed seed; cleared on reconnect. */
  private readonly seeded = new Set<string>()
  private snapshotCache: GitStateSnapshot
  private readonly notifier = new Notifier(() => {
    this.snapshotCache = this.buildSnapshot()
  })

  /** @param api - shared wire client. */
  constructor(private readonly api: IApiClient) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Seed one path's state through the unary resolve. A Host without the
   * domain (older build) and a transport failure both install the unavailable
   * placeholder instead of surfacing a connection error — the chip renders
   * nothing either way.
   * @param path - absolute directory to resolve once.
   */
  seed(path: string): void {
    if (this.seeded.has(path)) return
    this.seeded.add(path)
    void this.api.gitState.resolve({ path }).then(
      ({ result }) => {
        if (result.ok) this.install(path, result.value.state)
        else this.install(path, { type: 'unavailable', reason: `${result.error.code}: ${result.error.message}` })
      },
      (reason: unknown) => {
        this.install(path, { type: 'unavailable', reason: `git-state resolve failed: ${String(reason)}` })
      },
    )
  }

  /**
   * Drop entries whose paths no live session reports anymore; the next seed
   * for the same path re-resolves fresh.
   * @param wanted - paths currently accounted by some session cwd.
   */
  retainOnly(wanted: ReadonlySet<string>): void {
    const next: Record<string, GitRepositoryState> = {}
    let changed = false
    for (const [path, state] of Object.entries(this.entries)) {
      if (wanted.has(path)) next[path] = state
      else changed = true
    }
    for (const path of [...this.seeded]) {
      if (!wanted.has(path)) this.seeded.delete(path)
    }
    if (!changed) return
    this.entries = next
    this.notifier.markDirty()
  }

  /**
   * Host-frame entry. Non-git frames are ignored so the runtime can fan one
   * host stream out to every object manager.
   * @param envelope - host stream envelope.
   */
  handleHostEnvelope(envelope: RpcRequest<HostFrame>): void {
    if (envelope.payload.type === 'host/git-state-changed') {
      this.install(envelope.payload.path, envelope.payload.state)
    }
  }

  /** Re-seed after each connection generation: frames seen while offline are lost. */
  handleConnected(): void {
    this.seeded.clear()
  }

  /**
   * Subscribe to snapshot invalidation.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Read the cached snapshot after flushing pending notifications.
   * @returns the cached snapshot.
   */
  getSnapshot(): GitStateSnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  private install(path: string, state: GitRepositoryState): void {
    const previous = this.entries[path]
    if (previous !== undefined && statesEqual(previous, state)) return
    this.entries = { ...this.entries, [path]: state }
    this.notifier.markDirty()
  }

  private buildSnapshot(): GitStateSnapshot {
    return { entries: this.entries }
  }
}

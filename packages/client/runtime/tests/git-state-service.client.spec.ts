import { describe, expect, it } from 'vitest'
import type { HostFrame, RpcRequest, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionsPortList } from '../src/client/contract/sessions-port.ts'
import type { SessionSummary } from '../src/client/index.ts'
import { GitStateRuntime } from '../src/client/git-state/service.ts'
import { createSnapshotStore } from '../src/client/contract/store.ts'
import { FakeApiClient } from './fake-api.client.ts'

/**
 * The git-state runtime over a programmable fake API: per-session seeding,
 * host-frame updates, lifecycle release, and the absent-state vocabulary.
 */

const sid = (raw: string): SessionId => raw as SessionId

/** Minimal ctx stand-in: the runtime only provides itself on it. */
function stubCtx(): Context {
  return { reflect: { provide: () => {} } } as unknown as Context
}

function summary(id: string, cwd: string | undefined): SessionSummary {
  return {
    id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 1,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

function listState(rows: readonly SessionSummary[], current?: string): SessionsPortList {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    current: current === undefined ? undefined : sid(current),
    phase: 'ready',
  }
}

async function flushed(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('GitStateRuntime', () => {
  it('seeds a session cwd through resolve and follows host frames for it', async () => {
    const fake = new FakeApiClient()
    fake.onGitStateResolve = (payload: { path: string }) => Promise.resolve({
      state: payload.path === '/repo-a' ? { type: 'named-branch', branch: 'master' } : { type: 'no-repository' },
    })
    const sessions = createSnapshotStore<SessionsPortList>(listState([summary('s1', '/repo-a')]))
    const runtime = new GitStateRuntime(stubCtx(), fake, { list: sessions } as never)

    expect(runtime.stateForSession(sid('s1'))).toBeUndefined()
    await flushed()
    expect(runtime.stateForSession(sid('s1'))).toEqual({ type: 'named-branch', branch: 'master' })

    // Frames reach the domain through the runtime pump; tests call the entry directly.
    runtime.handleHostEnvelope({
      rpcId: 'r1' as never,
      payload: { type: 'host/git-state-changed', path: '/repo-a', state: { type: 'named-branch', branch: 'feature' } },
    })
    await flushed()
    expect(runtime.stateForSession(sid('s1'))).toEqual({ type: 'named-branch', branch: 'feature' })
  })

  it('resolves concurrent sessions in different repositories independently', async () => {
    const fake = new FakeApiClient()
    fake.onGitStateResolve = (payload: { path: string }) => Promise.resolve({
      state: payload.path === '/repo-a'
        ? { type: 'named-branch', branch: 'master' }
        : { type: 'detached', commit: '4f2a9c1' },
    })
    const sessions = createSnapshotStore<SessionsPortList>(
      listState([summary('s1', '/repo-a'), summary('s2', '/repo-b')]),
    )
    const runtime = new GitStateRuntime(stubCtx(), fake, { list: sessions } as never)
    await flushed()
    expect(runtime.stateForSession(sid('s1'))).toEqual({ type: 'named-branch', branch: 'master' })
    expect(runtime.stateForSession(sid('s2'))).toEqual({ type: 'detached', commit: '4f2a9c1' })
  })

  it('returns no state for a session without a cwd and never seeds one', async () => {
    const fake = new FakeApiClient()
    let calls = 0
    fake.onGitStateResolve = () => {
      calls += 1
      return Promise.resolve({ state: { type: 'no-repository' } })
    }
    const sessions = createSnapshotStore<SessionsPortList>(listState([summary('s1', undefined)]))
    const runtime = new GitStateRuntime(stubCtx(), fake, { list: sessions } as never)
    await flushed()
    expect(runtime.stateForSession(sid('s1'))).toBeUndefined()
    expect(calls).toBe(0)
  })

  it('releases an entry when its last session closes and re-seeds on reappear', async () => {
    const fake = new FakeApiClient()
    fake.onGitStateResolve = () => Promise.resolve({ state: { type: 'named-branch', branch: 'master' } })
    const sessions = createSnapshotStore<SessionsPortList>(listState([summary('s1', '/repo-a')]))
    const runtime = new GitStateRuntime(stubCtx(), fake, { list: sessions } as never)
    await flushed()
    expect(Object.keys(runtime.states.getSnapshot().entries)).toEqual(['/repo-a'])

    sessions.set(listState([]))
    await flushed()
    expect(runtime.states.getSnapshot().entries).toEqual({})

    // The session (or another on the same path) reappears: a fresh seed runs.
    sessions.set(listState([summary('s1', '/repo-a')]))
    await flushed()
    expect(runtime.stateForSession(sid('s1'))).toEqual({ type: 'named-branch', branch: 'master' })
  })

  it('keeps an entry alive while another session still shares its directory', async () => {
    const fake = new FakeApiClient()
    let resolves = 0
    fake.onGitStateResolve = () => {
      resolves += 1
      return Promise.resolve({ state: { type: 'named-branch', branch: 'main' } })
    }
    const sessions = createSnapshotStore<SessionsPortList>(
      listState([summary('s1', '/shared'), summary('s2', '/shared')]),
    )
    const runtime = new GitStateRuntime(stubCtx(), fake, { list: sessions } as never)
    await flushed()
    expect(resolves).toBe(1) // one seed for the shared directory

    // The first session closes; the second keeps the directory tracked.
    sessions.set(listState([summary('s2', '/shared')]))
    await flushed()
    expect(runtime.stateForSession(sid('s2'))).toEqual({ type: 'named-branch', branch: 'main' })
    expect(resolves).toBe(1)

    // The last session closes: the entry is released.
    sessions.set(listState([]))
    await flushed()
    expect(runtime.states.getSnapshot().entries).toEqual({})
  })

  it('treats a host without the domain as unavailable, not a connection error', async () => {
    const fake = new FakeApiClient()
    fake.onGitStateResolveResponse = () => Promise.resolve({
      rpcId: 'r-old-host' as never,
      result: {
        ok: false as const,
        error: { code: 'not-found' as const, message: 'unknown method gitState.resolve', details: {} },
      },
    } as never)
    const sessions = createSnapshotStore<SessionsPortList>(listState([summary('s1', '/repo-a')]))
    const runtime = new GitStateRuntime(stubCtx(), fake, { list: sessions } as never)
    await flushed()
    expect(runtime.stateForSession(sid('s1'))).toMatchObject({ type: 'unavailable' })
  })

  it('treats a transport failure as unavailable', async () => {
    const fake = new FakeApiClient()
    fake.onGitStateResolve = () => Promise.reject(new Error('network down'))
    const sessions = createSnapshotStore<SessionsPortList>(listState([summary('s1', '/repo-a')]))
    const runtime = new GitStateRuntime(stubCtx(), fake, { list: sessions } as never)
    await flushed()
    expect(runtime.stateForSession(sid('s1'))).toMatchObject({ type: 'unavailable', reason: /network down/ })
  })

  it('re-seeds every tracked path after a reconnect', async () => {
    const fake = new FakeApiClient()
    let answer = 0
    fake.onGitStateResolve = () => Promise.resolve({
      state: { type: 'named-branch', branch: `gen-${String(answer++)}` },
    })
    const sessions = createSnapshotStore<SessionsPortList>(listState([summary('s1', '/repo-a')]))
    const runtime = new GitStateRuntime(stubCtx(), fake, { list: sessions } as never)
    await flushed()
    expect(runtime.stateForSession(sid('s1'))).toEqual({ type: 'named-branch', branch: 'gen-0' })

    runtime.handleConnected()
    await flushed()
    expect(runtime.stateForSession(sid('s1'))).toEqual({ type: 'named-branch', branch: 'gen-1' })
  })

  it('suppresses duplicate frames that report the installed state', () => {
    const fake = new FakeApiClient()
    const sessions = createSnapshotStore<SessionsPortList>(listState([summary('s1', '/repo-a')]))
    const runtime = new GitStateRuntime(stubCtx(), fake, { list: sessions } as never)
    const envelope = (state: object): RpcRequest<HostFrame> => ({
      rpcId: 'r1' as never,
      payload: { type: 'host/git-state-changed', path: '/repo-a', state } as HostFrame,
    })
    runtime.handleHostEnvelope(envelope({ type: 'named-branch', branch: 'same' }))
    const firstSnapshot = runtime.states.getSnapshot()
    runtime.handleHostEnvelope(envelope({ type: 'named-branch', branch: 'same' }))
    expect(runtime.states.getSnapshot()).toBe(firstSnapshot)
  })
})

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { GitStateService } from '@deepseek-ai/dsh-git-state'
import type { GitRepositoryState, GitStateRequest, GitStateSpec } from '@deepseek-ai/dsh-git-state'
import type { HostFrame, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { Session } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

/**
 * The gitState wire domain over a scripted capability: determinate answers,
 * host-frame fan-out for tracked session cwds, and reference-counted
 * tracking across the sessions sharing one directory.
 */

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`git-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

async function nextHostFrame(stream: AsyncIterator<RpcRequest<HostFrame>>): Promise<RpcRequest<HostFrame>> {
  const next = await stream.next()
  if (next.done === true) throw new Error('Host stream ended before the expected increment')
  return next.value
}

/** Next GIT-STATE frame, skipping unrelated host pushes (session lifecycle et al). */
async function nextGitFrame(stream: AsyncIterator<RpcRequest<HostFrame>>): Promise<RpcRequest<HostFrame>> {
  for (;;) {
    const envelope = await nextHostFrame(stream)
    if (envelope.payload.type === 'host/git-state-changed') return envelope
  }
}

/** Scripted seam double: states per path, observers collectable and pokable. */
class ScriptedGitState extends GitStateService {
  readonly states = new Map<string, GitRepositoryState>()
  private readonly observers = new Map<string, Set<(state: GitRepositoryState) => void>>()

  resolve(request: GitStateRequest): GitStateSpec {
    return { path: request.path }
  }

  async run(spec: GitStateSpec): Promise<GitRepositoryState> {
    return this.states.get(spec.path) ?? { type: 'no-repository' }
  }

  attach(spec: GitStateSpec, observer: (state: GitRepositoryState) => void): () => void {
    let set = this.observers.get(spec.path)
    if (set === undefined) {
      set = new Set()
      this.observers.set(spec.path, set)
    }
    set.add(observer)
    queueMicrotask(() => {
      observer(this.states.get(spec.path) ?? { type: 'no-repository' })
    })
    return () => {
      this.observers.get(spec.path)?.delete(observer)
    }
  }

  /** Move a scripted path's state and notify its live observers. */
  emit(path: string, state: GitRepositoryState): void {
    this.states.set(path, state)
    for (const observer of this.observers.get(path) ?? []) observer(state)
  }

  /** How many live observers a path currently has. */
  countObservers(path: string): number {
    return this.observers.get(path)?.size ?? 0
  }
}

/** Compose the API over the same real spine the workspace spec uses; the
 *  git capability is mounted only when a scripted instance is supplied. */
/** Constructed inside the harness so the Service base receives its context. */
async function harness(withCapability: boolean): Promise<{
  api: ReturnType<typeof createApiProxy>
  ctx: Context
  git: ScriptedGitState | undefined
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  ctx.agents.setFactory({
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = {
        id: session.id,
        options: {},
        session,
        inbox: { inserted: () => {}, discarded: () => {}, claimed: () => {} },
        status: 'idle',
        ctx: new Context(),
        send: () => {},
        followup: () => {},
        steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
        inject: () => {},
        cancel(): void {},
        runMaintenance: (job: (signal: AbortSignal) => void) => {
          job(new AbortController().signal)
        },
        whenIdle: () => Promise.resolve(),
      } as never
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          return Promise.resolve()
        },
      }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  })
  ctx.provide('directoryPicker', { capability: () => ({ kind: 'native', pick: async () => null }) } as never)
  // Cordis Service construction registers the instance as ctx.gitState.
  const git = withCapability ? new ScriptedGitState(ctx) : undefined
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-git-'))),
  })
  return { api, ctx, git }
}

/** A minimal session stand-in carrying what the frame path and tracker read. */
function fakeSession(cwd: string | undefined): Session {
  return { id: 'fx' as never, header: { cwd }, events: [] } as unknown as Session
}

const abort = new AbortController()

describe('gitState.resolve', () => {
  it('answers unavailable when the capability is not mounted', async () => {
    const { api } = await harness(false)
    const value = expectOk(await api.gitState.resolve(request({ path: '/repo' })))
    expect(value.state).toEqual({ type: 'unavailable', reason: 'the Git repository-state capability is not mounted' })
  })

  it('resolves one path through the mounted capability', async () => {
    const { api, git } = await harness(true)
    git?.states.set('/repo', { type: 'named-branch', branch: 'master' })
    const value = expectOk(await api.gitState.resolve(request({ path: '/repo' })))
    expect(value.state).toEqual({ type: 'named-branch', branch: 'master' })
  })
})

describe('host/git-state-changed fan-out', () => {
  it('pushes tracked-path changes to every open host stream and baselines late subscribers', async () => {
    const { api, ctx, git } = await harness(true)

    const first = api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    // Tracking installs at proxy mount only when sessions exist; a later
    // creation is the ordinary UI flow.
    git?.states.set('/repo', { type: 'named-branch', branch: 'master' })
    ctx.emit('session/created', fakeSession('/repo'))

    await expect(nextGitFrame(first)).resolves.toMatchObject({
      payload: { type: 'host/git-state-changed', path: '/repo', state: { type: 'named-branch', branch: 'master' } },
    })

    // A second subscriber baselines with the CURRENT known state.
    git?.emit('/repo', { type: 'named-branch', branch: 'feature' })
    await expect(nextGitFrame(first)).resolves.toMatchObject({
      payload: { type: 'host/git-state-changed', path: '/repo', state: { type: 'named-branch', branch: 'feature' } },
    })
    const second = api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    await expect(nextGitFrame(second)).resolves.toMatchObject({
      payload: { type: 'host/git-state-changed', path: '/repo', state: { type: 'named-branch', branch: 'feature' } },
    })

    // Both streams receive subsequent transitions.
    git?.emit('/repo', { type: 'detached', commit: '4f2a9c1' })
    await expect(nextGitFrame(first)).resolves.toMatchObject({ payload: { state: { type: 'detached' } } })
    await expect(nextGitFrame(second)).resolves.toMatchObject({ payload: { state: { type: 'detached' } } })
    abort.abort()
  })

  it('stops observing a path after its last accounting session disposes', async () => {
    const { api, ctx, git } = await harness(true)
    const stream = api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()

    ctx.emit('session/created', fakeSession('/repo'))
    await expect(nextGitFrame(stream)).resolves.toBeTypeOf('object')
    expect(git?.countObservers('/repo')).toBe(1)

    // A second session sharing the directory keeps the observation alive.
    ctx.emit('session/created', fakeSession('/repo'))
    expect(git?.countObservers('/repo')).toBe(1)
    ctx.emit('session/disposed', fakeSession('/repo'))
    expect(git?.countObservers('/repo')).toBe(1)

    ctx.emit('session/disposed', fakeSession('/repo'))
    expect(git?.countObservers('/repo')).toBe(0)
    abort.abort()
  })

  it('emits no git-state frame for tracked paths without the capability mounted', async () => {
    const { api, ctx } = await harness(false)
    const stream = api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    ctx.emit('session/created', fakeSession('/repo'))
    // Drain whatever immediate frames flow (session lifecycle); none may be a
    // git-state push, and no late one may arrive either.
    for (let i = 0; i < 3; i += 1) {
      const outcome = await Promise.race([
        stream.next().then(next => (next.done === true ? undefined : next.value)),
        new Promise<'quiet'>((resolve) => {
          setTimeout(() => {
            resolve('quiet')
          }, 40)
        }),
      ])
      if (outcome === 'quiet' || outcome === undefined) break
      expect(outcome.payload.type).not.toBe('host/git-state-changed')
    }
    abort.abort()
  })
})

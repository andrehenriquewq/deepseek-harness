import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GitStateService } from '@deepseek-ai/dsh-git-state'
import type { GitRepositoryState, GitStateRequest, GitStateSpec } from '@deepseek-ai/dsh-git-state'

/**
 * Minimal concrete service: canned states. The seam owns no resolution
 * semantics; every behavior lives in a provider.
 */
class StubGitState extends GitStateService {
  resolve(request: GitStateRequest): GitStateSpec {
    return { path: request.path }
  }

  async run(): Promise<GitRepositoryState> {
    return { type: 'no-repository' }
  }

  attach(_spec: GitStateSpec, observer: (state: GitRepositoryState) => void): () => void {
    observer({ type: 'no-repository' })
    return () => {}
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(StubGitState)
  return ctx
}

describe('GitStateService service seam', () => {
  it('a concrete subclass registers as ctx.gitState and serves the abstract API', async () => {
    const ctx = await setup()
    expect(ctx.gitState.resolve({ path: '/x' })).toEqual({ path: '/x' })
    await expect(ctx.gitState.run(ctx.gitState.resolve({ path: '/x' }))).resolves.toEqual({ type: 'no-repository' })
    const seen: GitRepositoryState[] = []
    const release = ctx.gitState.attach({ path: '/x' }, state => seen.push(state))
    release()
    expect(seen).toEqual([{ type: 'no-repository' }])
  })

  it('loading a second implementation throws (one gitState service per context — cordis standard)', async () => {
    const ctx = await setup()
    class SecondService extends StubGitState {}
    await expect(ctx.plugin(SecondService)).rejects.toThrow(/service "gitState" has been registered/)
  })
})

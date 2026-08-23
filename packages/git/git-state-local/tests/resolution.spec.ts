import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalGitStateService } from '@deepseek-ai/dsh-git-state-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { GitRepositoryState } from '@deepseek-ai/dsh-git-state'

/**
 * Resolution scenarios from specs/git-repository-state/spec.md against real
 * fixture repositories built with the local git binary.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString()
}

let world: string

async function service(): Promise<LocalGitStateService> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalGitStateService, { watchDebounceMs: 20, pollIntervalMs: 50 })
  return ctx.gitState as LocalGitStateService
}

function resolveOne(gitState: LocalGitStateService, path: string): Promise<GitRepositoryState> {
  return gitState.run(gitState.resolve({ path }))
}

beforeAll(() => {
  world = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-git-state-'))
  const repo = nodePath.join(world, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q', '--initial-branch=master', '.'])
  fs.writeFileSync(nodePath.join(repo, 'f.txt'), 'one\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'c1'])
  fs.mkdirSync(nodePath.join(repo, 'deep', 'nested'), { recursive: true })
  // Linked worktree on its own branch, plus a detached one off the same commit.
  git(repo, ['worktree', 'add', '-q', '-b', 'feature', nodePath.join(world, 'wt')])
  git(repo, ['worktree', 'add', '-q', '--detach', nodePath.join(world, 'dt')])
})

afterAll(() => {
  fs.rmSync(world, { recursive: true, force: true, maxRetries: 3 })
})

describe('resolution over real fixture repositories', () => {
  it('resolves the repository root to its named branch', async () => {
    const gitState = await service()
    await expect(resolveOne(gitState, nodePath.join(world, 'repo'))).resolves.toEqual({ type: 'named-branch', branch: 'master' })
  })

  it('resolves a nested subdirectory to the working-tree root branch', async () => {
    const gitState = await service()
    await expect(resolveOne(gitState, nodePath.join(world, 'repo', 'deep', 'nested')))
      .resolves.toEqual({ type: 'named-branch', branch: 'master' })
  })

  it('resolves a linked worktree to ITS branch, not the main working tree branch', async () => {
    const gitState = await service()
    await expect(resolveOne(gitState, nodePath.join(world, 'wt'))).resolves.toEqual({ type: 'named-branch', branch: 'feature' })
  })

  it('reports a detached HEAD with an abbreviated commit identifier, tagged as detached', async () => {
    const gitState = await service()
    const state = await resolveOne(gitState, nodePath.join(world, 'dt'))
    expect(state.type).toBe('detached')
    if (state.type !== 'detached') return
    expect(state.commit).toMatch(/^[0-9a-f]+$/)
    expect(state.commit.length).toBeGreaterThanOrEqual(7)
    expect(state.commit.length).toBeLessThan(40)
  })

  it('reports no-repository for a directory outside any repository', async () => {
    const plain = nodePath.join(world, 'plain')
    fs.mkdirSync(plain)
    const gitState = await service()
    await expect(resolveOne(gitState, plain)).resolves.toEqual({ type: 'no-repository' })
  })

  it('reports unavailable for a missing path, with the reason carried for diagnostics', async () => {
    const gitState = await service()
    const state = await resolveOne(gitState, nodePath.join(world, 'missing'))
    expect(state).toMatchObject({ type: 'unavailable' })
    if (state.type === 'unavailable') expect(state.reason).toContain('cannot read')
  })

  it('reports unavailable for a path that is not a directory', async () => {
    const file = nodePath.join(world, 'afile')
    fs.writeFileSync(file, 'x')
    const gitState = await service()
    await expect(resolveOne(gitState, file)).resolves.toMatchObject({ type: 'unavailable' })
  })

  it('reports unavailable — never a fabricated name — when repository metadata is corrupt', async () => {
    const corrupt = nodePath.join(world, 'corrupt')
    fs.rmSync(corrupt, { recursive: true, force: true })
    fs.cpSync(nodePath.join(world, 'repo'), corrupt, { recursive: true })
    fs.writeFileSync(nodePath.join(corrupt, '.git', 'HEAD'), 'garbage\n')
    const gitState = await service()
    const state = await resolveOne(gitState, corrupt)
    expect(state.type).toBe('unavailable')
    if (state.type === 'unavailable') expect(state.reason).toContain('repository metadata is unreadable')
  })

  it('relative request paths resolve against the provider working directory', async () => {
    const gitState = await service()
    const cwd = process.cwd()
    try {
      process.chdir(world)
      const resolved = gitState.resolve({ path: 'sub' })
      expect(resolved['path']).toBe(nodePath.resolve(process.cwd(), 'sub'))
      expect(nodePath.isAbsolute(resolved['path'])).toBe(true)
    } finally {
      process.chdir(cwd)
    }
  })

  it('resolve() never returns a relative spec path', async () => {
    const gitState = await service()
    expect(gitState.resolve({ path: 'some/rel' })['path']).toMatch(/^[/\\]/)
  })
})

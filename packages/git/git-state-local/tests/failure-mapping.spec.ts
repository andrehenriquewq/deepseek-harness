import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalGitStateService } from '@deepseek-ai/dsh-git-state-local'
import type { GitRepositoryState } from '@deepseek-ai/dsh-git-state'
import { FakeSubprocess, stageFakeScripts } from './fake-subprocess.ts'
import type { ScriptedGit } from './fake-subprocess.ts'

/**
 * Every Git failure mode maps onto a determinate state — never a throw, never
 * a fabricated branch name. Uses the scripted binary for full control over
 * each failure shape.
 */

let world: string
let dir: string
let ctx: Context | undefined

async function runWith(...scripts: readonly ScriptedGit[]): Promise<GitRepositoryState> {
  stageFakeScripts(...scripts)
  ctx = new Context()
  await ctx.plugin(FakeSubprocess)
  await ctx.plugin(LocalGitStateService, { watchDebounceMs: 20, pollIntervalMs: 50 })
  const gitState = ctx.gitState as LocalGitStateService
  return gitState.run(gitState.resolve({ path: dir }))
}

beforeEach(() => {
  world = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-git-fail-'))
  dir = nodePath.join(world, 'd')
  fs.mkdirSync(dir)
})

afterEach(async () => {
  if (ctx !== undefined) await ctx.fiber.dispose()
  ctx = undefined
  fs.rmSync(world, { recursive: true, force: true, maxRetries: 3 })
})

describe('failure-mode mapping', () => {
  it('maps a failed git execution to unavailable', async () => {
    const state = await runWith({ argvTail: ['rev-parse', '--git-dir'], exitCode: 0, failSpawn: true })
    expect(state.type).toBe('unavailable')
    if (state.type === 'unavailable') expect(state.reason).toContain('git executable could not be executed')
  })

  it('maps a non-repository verdict to no-repository when no local .git entry exists', async () => {
    await expect(runWith({ argvTail: ['rev-parse', '--git-dir'], exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }))
      .resolves.toEqual({ type: 'no-repository' })
  })

  it('maps a local .git entry Git refuses to interpret to unavailable (corruption)', async () => {
    fs.mkdirSync(nodePath.join(dir, '.git'))
    const state = await runWith({ argvTail: ['rev-parse', '--git-dir'], exitCode: 128, stderr: 'fatal: not a git repository\n' })
    expect(state.type).toBe('unavailable')
    if (state.type === 'unavailable') expect(state.reason).toContain('repository metadata is unreadable')
  })

  it('maps an unrecognized discovery failure to unavailable with the diagnostic', async () => {
    const state = await runWith({ argvTail: ['rev-parse', '--git-dir'], exitCode: 128, stderr: 'fatal: weird condition\n' })
    expect(state.type).toBe('unavailable')
    if (state.type === 'unavailable') expect(state.reason).toContain('weird condition')
  })

  it('names an empty diagnostic instead of fabricating one', async () => {
    await expect(runWith({ argvTail: ['rev-parse', '--git-dir'], exitCode: 1, stderr: '', stdout: '' }))
      .resolves.toMatchObject({ type: 'unavailable', reason: 'git rev-parse failed: no diagnostic output' })
  })

  it('resolves a detached HEAD with its abbreviated commit', async () => {
    await expect(runWith(
      { argvTail: ['rev-parse', '--git-dir'], exitCode: 0, stdout: '.git\n' },
      { argvTail: ['rev-parse', '--abbrev-ref', 'HEAD'], exitCode: 0, stdout: 'HEAD\n' },
      { argvTail: ['rev-parse', '--short', 'HEAD'], exitCode: 0, stdout: '4f2a9c1\n' },
    )).resolves.toEqual({ type: 'detached', commit: '4f2a9c1' })
  })

  it('maps an unreadable detached commit to unavailable', async () => {
    const state = await runWith(
      { argvTail: ['rev-parse', '--git-dir'], exitCode: 0, stdout: '.git\n' },
      { argvTail: ['rev-parse', '--abbrev-ref', 'HEAD'], exitCode: 0, stdout: 'HEAD\n' },
      { argvTail: ['rev-parse', '--short', 'HEAD'], exitCode: 1, stderr: 'fatal: broken\n' },
    )
    expect(state.type).toBe('unavailable')
    if (state.type === 'unavailable') expect(state.reason).toContain('detached HEAD commit is unreadable')
  })

  it('maps a failed execution during detached-commit lookup to unavailable', async () => {
    const state = await runWith(
      { argvTail: ['rev-parse', '--git-dir'], exitCode: 0, stdout: '.git\n' },
      { argvTail: ['rev-parse', '--abbrev-ref', 'HEAD'], exitCode: 0, failSpawn: true },
    )
    expect(state.type).toBe('unavailable')
    if (state.type === 'unavailable') expect(state.reason).toContain('git executable could not be executed')
  })

  it('maps a failed execution during detached-commit resolution to unavailable', async () => {
    const state = await runWith(
      { argvTail: ['rev-parse', '--git-dir'], exitCode: 0, stdout: '.git\n' },
      { argvTail: ['rev-parse', '--abbrev-ref', 'HEAD'], exitCode: 0, stdout: 'HEAD\n' },
      { argvTail: ['rev-parse', '--short', 'HEAD'], exitCode: 0, failSpawn: true },
    )
    expect(state.type).toBe('unavailable')
    if (state.type === 'unavailable') expect(state.reason).toContain('git executable could not be executed')
  })

  it('reports repository metadata as unreadable when HEAD resolution fails on a discovered repository', async () => {
    const state = await runWith(
      { argvTail: ['rev-parse', '--git-dir'], exitCode: 0, stdout: '.git\n' },
      { argvTail: ['rev-parse', '--abbrev-ref', 'HEAD'], exitCode: 128, stderr: "fatal: ambiguous argument 'HEAD'\n" },
    )
    expect(state.type).toBe('unavailable')
    if (state.type === 'unavailable') expect(state.reason).toContain('repository metadata is unreadable')
  })

  it('never throws when the target disappears mid-resolution', async () => {
    stageFakeScripts()
    ctx = new Context()
    await ctx.plugin(FakeSubprocess)
    await ctx.plugin(LocalGitStateService, { watchDebounceMs: 20, pollIntervalMs: 50 })
    const gitState = ctx.gitState as LocalGitStateService
    const spec = gitState.resolve({ path: dir })
    fs.rmSync(dir, { recursive: true })
    await expect(gitState.run(spec)).resolves.toMatchObject({ type: 'unavailable' })
  })
})

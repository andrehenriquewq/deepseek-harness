import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { assertServiceableGitStateConfig, LocalGitStateService } from '@deepseek-ai/dsh-git-state-local'
import type { Config } from '@deepseek-ai/dsh-git-state-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { FakeSubprocess, stageFakeScripts } from './fake-subprocess.ts'

describe('provider config validation', () => {
  let world: string
  let dir: string
  let ctx: Context | undefined

  beforeEach(() => {
    world = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-git-cfg-'))
    dir = nodePath.join(world, 'd')
    fs.mkdirSync(dir)
  })

  afterEach(async () => {
    if (ctx !== undefined) await ctx.fiber.dispose()
    ctx = undefined
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 3 })
  })

  it('accepts a fully-specified section', () => {
    expect(() => {
      assertServiceableGitStateConfig({ watchDebounceMs: 150, pollIntervalMs: 5_000 })
    }).not.toThrow()
  })

  it('rejects zero, negative, and non-finite values for both fields', () => {
    const base: Required<Config> = { watchDebounceMs: 1, pollIntervalMs: 1 }
    for (const field of ['watchDebounceMs', 'pollIntervalMs'] as const) {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => {
          assertServiceableGitStateConfig({ ...base, [field]: value })
        }).toThrow(new RegExp(`${field} must be a positive finite number`))
      }
    }
  })

  it('rejects values beyond the timer bound', () => {
    expect(() => {
      assertServiceableGitStateConfig({ watchDebounceMs: MAX_TIMER_DELAY_MS + 1, pollIntervalMs: 1 })
    }).toThrow(/watchDebounceMs must be no greater than/)
    expect(() => {
      assertServiceableGitStateConfig({ watchDebounceMs: 1, pollIntervalMs: MAX_TIMER_DELAY_MS + 1 })
    }).toThrow(/pollIntervalMs must be no greater than/)
  })

  it('fails loud at plugin load on an unusable stored value', async () => {
    ctx = new Context()
    await ctx.plugin(FakeSubprocess)
    await expect(ctx.plugin(LocalGitStateService, { watchDebounceMs: -5 }))
      .rejects.toThrow(/watchDebounceMs must be a positive finite number/)
  })

  it('applies the schema defaults when composed without overrides', async () => {
    stageFakeScripts({ argvTail: ['rev-parse', '--git-dir'], exitCode: 128, stderr: 'fatal: not a git repository\n' })
    ctx = new Context()
    await ctx.plugin(FakeSubprocess)
    // No config object: schemastery's static Config supplies every default.
    await ctx.plugin(LocalGitStateService)
    const fake = ctx.subprocess as FakeSubprocess
    const gitState = ctx.gitState as LocalGitStateService
    await expect(gitState.run(gitState.resolve({ path: dir })))
      .resolves.toEqual({ type: 'no-repository' })
    expect(fake.consumed).toBeGreaterThan(0)
  })
})

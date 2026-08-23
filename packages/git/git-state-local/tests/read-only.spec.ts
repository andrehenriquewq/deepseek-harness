import { execFileSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalGitStateService } from '@deepseek-ai/dsh-git-state-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/**
 * The read-only guarantee (specs/git-repository-state/spec.md): a full
 * observation lifecycle — resolution, watch-driven branch switch, release —
 * leaves the repository and working tree byte-identical. The lifecycle's only
 * intended write is the HEAD rewrite the test itself performs to simulate a
 * checkout; it is restored before comparison.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** relPath → content digest for every file under root, sorted by path. */
function snapshot(root: string): Map<string, string> {
  const entries = new Map<string, string>()
  const walk = (relative: string): void => {
    const absolute = nodePath.join(root, relative)
    for (const item of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = nodePath.join(relative, item.name)
      if (item.isDirectory()) walk(childRelative)
      else if (item.isFile()) {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(nodePath.join(root, childRelative))).digest('hex')
        entries.set(childRelative, digest)
      }
    }
  }
  walk('.')
  return entries
}

let world: string
let repo: string
let originalHead: string

beforeAll(() => {
  world = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-git-ro-'))
  repo = nodePath.join(world, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q', '--initial-branch=main', '.'])
  fs.writeFileSync(nodePath.join(repo, 'file.txt'), 'content\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'c1'])
  fs.writeFileSync(nodePath.join(repo, 'other.txt'), 'other\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'c2'])
  git(repo, ['branch', 'feature'])
})

afterAll(() => {
  fs.rmSync(world, { recursive: true, force: true, maxRetries: 3 })
})

describe('read-only guarantee over a full observation lifecycle', () => {
  it('leaves repository and working tree byte-identical', async () => {
    const before = snapshot(repo)
    originalHead = fs.readFileSync(nodePath.join(repo, '.git', 'HEAD'), 'utf8')

    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalGitStateService, { watchDebounceMs: 20, pollIntervalMs: 50 })
    const gitState = ctx.gitState as LocalGitStateService

    // One-shot resolutions interleaved with an observation lifecycle.
    await expect(gitState.run(gitState.resolve({ path: repo }))).resolves.toEqual({ type: 'named-branch', branch: 'main' })

    const seen: string[] = []
    const release = gitState.attach(gitState.resolve({ path: repo }), (state) => {
      if (state.type === 'named-branch') seen.push(state.branch)
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(seen).toContain('main')
      // Simulate the agent switching branches WITHOUT invoking git: rewriting
      // HEAD is exactly the filesystem event the provider watches.
      fs.writeFileSync(nodePath.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature\n')
      await new Promise(resolve => setTimeout(resolve, 1500))
      expect(seen).toContain('feature')
    } finally {
      release()
      await ctx.fiber.dispose()
      // Restore the test's own simulated-checkout write before comparing.
      fs.writeFileSync(nodePath.join(repo, '.git', 'HEAD'), originalHead)
    }

    expect(snapshot(repo)).toEqual(before)
  })
})

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalGitStateService } from '@deepseek-ai/dsh-git-state-local'
import type { GitRepositoryState } from '@deepseek-ai/dsh-git-state'
import { FakeSubprocess, stageFakeScripts } from './fake-subprocess.ts'
import type { ScriptedGit } from './fake-subprocess.ts'

/**
 * Observation semantics over a scripted git binary and REAL filesystem
 * watching: the fake answers `rev-parse` queries while tests touch real files
 * to drive the watch/debounce/poll machinery. The instrumented subclass adds
 * watch introspection over the protected startWatch seam (node:fs namespaces
 * cannot be spied under ESM).
 */

const DEBOUNCE_MS = 25
const POLL_MS = 50

class InstrumentedGitState extends LocalGitStateService {
  /** Every startWatch registration, in order. */
  readonly watchTargets: string[] = []
  /** Fires the runtime error of the watcher registered for a target. */
  readonly emitWatchError = new Map<string, () => void>()
  /** When set, startWatch throws synchronously — the registration-failure mode. */
  failRegistration = false
  /** When set, startWatch returns an inert stub and records the event trigger. */
  stubWatch = false
  readonly injectedEvents: Array<() => void> = []

  /** Test observability: entries currently running their poll fallback. */
  get pollingKeys(): string[] {
    const out: string[] = []
    for (const [key, entry] of (this as unknown as { entries: Map<string, { poll?: NodeJS.Timeout }> }).entries) {
      if (entry.poll !== undefined) out.push(key)
    }
    return out
  }

  protected override startWatch(target: string, onEvent: () => void, onError: () => void): fs.FSWatcher {
    return this.instrumentedStartWatch(target, onEvent, onError)
  }

  private instrumentedStartWatch(target: string, onEvent: () => void, onError: () => void): fs.FSWatcher {
    this.watchTargets.push(target)
    if (this.failRegistration) throw new Error('watch unavailable in this sandbox')
    if (this.stubWatch) {
      this.injectedEvents.push(onEvent)
      return { close: () => {} } as fs.FSWatcher
    }
    const watcher = super.startWatch(target, onEvent, onError)
    this.emitWatchError.set(target, () => { watcher.emit('error', new Error('instrumented watch failure')) })
    return watcher
  }
}

let world: string
let repoDir: string
let headFile: string
let plainDir: string
let branchScript: ScriptedGit
let discoveryScript: ScriptedGit
let ctx: Context | undefined

/** The scripted repository state: discovery succeeds and HEAD names this branch. */
function onBranch(name: string): void {
  branchScript.stdout = `${name}\n`
}

/** Flip whether git discovers a repository at all (the no-repository mode). */
function discoveryFails(): void {
  discoveryScript.exitCode = 128
  discoveryScript.stderr = 'fatal: not a git repository (or any of the parent directories): .git\n'
  discoveryScript.stdout = ''
}

function writeHead(content: string): void {
  fs.writeFileSync(headFile, content)
}

async function setup(
  serviceClass: typeof LocalGitStateService = LocalGitStateService,
  config: { watchDebounceMs?: number; pollIntervalMs?: number } = {},
): Promise<LocalGitStateService> {
  ctx = new Context()
  await ctx.plugin(FakeSubprocess)
  await ctx.plugin(serviceClass, {
    watchDebounceMs: config.watchDebounceMs ?? DEBOUNCE_MS,
    pollIntervalMs: config.pollIntervalMs ?? POLL_MS,
  })
  return ctx.gitState as LocalGitStateService
}

function subprocess(): FakeSubprocess {
  return (ctx as Context).subprocess as FakeSubprocess
}

beforeEach(() => {
  vi.restoreAllMocks()
  world = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-git-obs-'))
  repoDir = nodePath.join(world, 'repo')
  plainDir = nodePath.join(world, 'plain')
  fs.mkdirSync(repoDir)
  fs.mkdirSync(plainDir)
  fs.mkdirSync(nodePath.join(repoDir, '.git'))
  headFile = nodePath.join(repoDir, '.git', 'HEAD')
  writeHead('ref: refs/heads/master\n')
  branchScript = { argvTail: ['rev-parse', '--abbrev-ref', 'HEAD'], exitCode: 0, stdout: 'master\n' }
  // One mutable script per query shape; scripts stay installed across
  // re-resolutions, and tests mutate them to move the scripted state.
  discoveryScript = { argvTail: ['rev-parse', '--git-dir'], exitCode: 0, stdout: '.git\n', stderr: '' }
  stageFakeScripts(
    discoveryScript,
    // --git-common-dir answers with an ABSOLUTE path; --git-dir above answers
    // relative — both input shapes of absoluteDirectory stay exercised.
    { argvTail: ['rev-parse', '--git-common-dir'], exitCode: 0, stdout: nodePath.join(repoDir, '.git') },
    { argvTail: ['rev-parse', '--short', 'HEAD'], exitCode: 1, stderr: 'fatal: not a git repository\n' },
    branchScript,
  )
})

afterEach(async () => {
  if (ctx !== undefined) await ctx.fiber.dispose()
  ctx = undefined
  fs.rmSync(world, { recursive: true, force: true, maxRetries: 3 })
})

function collect(gitState: LocalGitStateService, path: string): { seen: GitRepositoryState[]; release: () => void } {
  const seen: GitRepositoryState[] = []
  const release = gitState.attach(gitState.resolve({ path }), state => seen.push(state))
  return { seen, release }
}

const lastOf = (seen: GitRepositoryState[]): GitRepositoryState | undefined => seen[seen.length - 1]

describe('observation lifecycle', () => {
  it('reports the current state shortly after attach', async () => {
    const gitState = await setup()
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen).toEqual([{ type: 'named-branch', branch: 'master' }])
    })
    release()
  })

  it('reports a branch switch observed through the HEAD watch', async () => {
    const gitState = await setup()
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen.length).toBe(1)
    })
    onBranch('feature')
    writeHead('ref: refs/heads/feature\n')
    await vi.waitFor(() => {
      expect(lastOf(seen)).toEqual({ type: 'named-branch', branch: 'feature' })
    })
    release()
  })

  it('suppresses notification when re-resolution yields the already-reported state', async () => {
    const gitState = await setup()
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen.length).toBe(1)
    })
    // A byte-level HEAD change whose re-resolved STATE is unchanged must stay silent.
    writeHead('ref: refs/heads/master\n')
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 4)
    })
    expect(seen.length).toBe(1)
    // Release with a freshly armed debounce timer: teardown must clear it.
    writeHead('ref: refs/heads/master\n')
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS / 2)
    })
    release()
    const settled = subprocess().consumed
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 3)
    })
    expect(subprocess().consumed).toBe(settled)
    expect(seen.length).toBe(1)
  })

  it('reports a newly created branch checked out mid-observation', async () => {
    const gitState = await setup()
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen.length).toBe(1)
    })
    onBranch('fresh-branch')
    writeHead('ref: refs/heads/fresh-branch\n')
    await vi.waitFor(() => {
      expect(lastOf(seen)).toEqual({ type: 'named-branch', branch: 'fresh-branch' })
    })
    release()
  })

  it('coalesces a burst of watch events into one debounced re-resolution pass', async () => {
    const gitState = (await setup(InstrumentedGitState)) as InstrumentedGitState
    gitState.stubWatch = true
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen).toEqual([{ type: 'named-branch', branch: 'master' }])
    })

    const before = subprocess().consumed
    // Two raw events inside one debounce window coalesce into ONE pass.
    const fire = gitState.injectedEvents.find(() => true)
    fire?.()
    fire?.()
    await vi.waitFor(() => {
      expect(subprocess().consumed - before).toBe(2)
    })
    expect(seen.length).toBe(1) // unchanged scripted state → silent
    release()
  })

  it('stops reporting after release, and release is idempotent', async () => {
    const gitState = await setup()
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen.length).toBe(1)
    })
    release()
    release()
    const before = subprocess().consumed
    onBranch('after-release')
    writeHead('ref: refs/heads/after-release\n')
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 5)
    })
    expect(seen.length).toBe(1)
    expect(subprocess().consumed).toBe(before)
  })
})

describe('reference-counted watching', () => {
  it('three callers on one repository hold one watcher and each receives every change', async () => {
    const gitState = (await setup(InstrumentedGitState)) as InstrumentedGitState
    const a = collect(gitState, repoDir)
    const b = collect(gitState, repoDir)
    const c = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(a.seen.length).toBe(1)
    })
    // One shared watcher over the resolved HEAD file — not one per caller.
    expect(gitState.watchTargets.filter(target => target === nodePath.join(repoDir, '.git'))).toHaveLength(1)

    onBranch('shared')
    writeHead('ref: refs/heads/shared\n')
    await vi.waitFor(() => {
      expect(lastOf(b.seen)).toEqual({ type: 'named-branch', branch: 'shared' })
    })
    expect(lastOf(a.seen)).toEqual({ type: 'named-branch', branch: 'shared' })
    expect(lastOf(c.seen)).toEqual({ type: 'named-branch', branch: 'shared' })

    a.release()
    onBranch('after-one-leaves')
    writeHead('ref: refs/heads/after-one-leaves\n')
    await vi.waitFor(() => {
      expect(lastOf(b.seen)).toEqual({ type: 'named-branch', branch: 'after-one-leaves' })
    })
    expect(lastOf(c.seen)).toEqual({ type: 'named-branch', branch: 'after-one-leaves' })
    expect(lastOf(a.seen)).toEqual({ type: 'named-branch', branch: 'shared' })

    b.release()
    c.release()
    const before = subprocess().consumed
    writeHead('ref: refs/heads/nobody-listening\n')
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 5)
    })
    // The last release destroyed the shared watcher: no further resolution work happens.
    expect(subprocess().consumed).toBe(before)
  })
})

describe('directory becoming a repository while observed', () => {
  it('reports the transition and re-keys the watch onto repository metadata', async () => {
    const gitState = await setup()
    discoveryFails()
    const { seen } = collect(gitState, plainDir)
    await vi.waitFor(() => {
      expect(seen).toEqual([{ type: 'no-repository' }])
    })

    // A repository appears at the observed directory; its HEAD exists before the
    // debounced pass runs, so the migrated watcher attaches to a real file.
    fs.mkdirSync(nodePath.join(plainDir, '.git'))
    fs.writeFileSync(nodePath.join(plainDir, '.git', 'HEAD'), 'ref: refs/heads/born\n')
    onBranch('born')
    discoveryScript.exitCode = 0
    discoveryScript.stderr = ''
    discoveryScript.stdout = '.git\n'
    subprocess().scriptContaining('--git-common-dir').stdout = nodePath.join(plainDir, '.git')

    await vi.waitFor(() => {
      expect(lastOf(seen)).toEqual({ type: 'named-branch', branch: 'born' })
    })

    // Re-keyed onto the repository entry: HEAD changes there now drive updates.
    onBranch('moved')
    // A HEAD rewrite inside .git drives updates through the directory watch.
    fs.writeFileSync(nodePath.join(plainDir, '.git', 'HEAD'), 'ref: refs/heads/moved\n')
    await vi.waitFor(() => {
      expect(lastOf(seen)).toEqual({ type: 'named-branch', branch: 'moved' })
    })
  })
})

describe('polling fallback where watching is unavailable', () => {
  it('falls back to interval re-resolution when watch registration fails', async () => {
    const gitState = (await setup(InstrumentedGitState)) as InstrumentedGitState
    gitState.failRegistration = true
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen).toEqual([{ type: 'named-branch', branch: 'master' }])
    })
    onBranch('polled')
    // No filesystem event can fire (no watcher exists); the interval must find it.
    await vi.waitFor(
      () => {
        expect(lastOf(seen)).toEqual({ type: 'named-branch', branch: 'polled' })
      },
      { timeout: POLL_MS * 8 },
    )
    // Release with the poll interval live: teardown must clear it.
    release()
    const settled = subprocess().consumed
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS * 3)
    })
    expect(subprocess().consumed).toBe(settled)
  })

  it('degrades to polling when a live watcher reports an error', async () => {
    const gitState = (await setup(InstrumentedGitState)) as InstrumentedGitState
    const { seen } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen.length).toBe(1)
    })
    // Placement completes AFTER the initial notification; wait for the watch.
    await vi.waitFor(() => {
      expect(gitState.watchTargets.filter(target => target === nodePath.join(repoDir, '.git'))).toHaveLength(1)
    })

    // The runtime watch fails after registration...
    const emitError = gitState.emitWatchError.get(nodePath.join(repoDir, '.git'))
    emitError?.()
    // ...a second failure is a no-op (already polling)...
    emitError?.()
    // ...and the entry must keep reporting through the interval, not die.
    onBranch('degraded')
    await vi.waitFor(
      () => {
        expect(lastOf(seen)).toEqual({ type: 'named-branch', branch: 'degraded' })
      },
      { timeout: POLL_MS * 8 },
    )
  })

  it('drops an observation released while its placement query is in flight', async () => {
    const gitState = (await setup(InstrumentedGitState)) as InstrumentedGitState
    let unhold: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      unhold = resolve
    })
    // Gate the FIRST placement query; the initial resolution completes ungated.
    subprocess().scriptContaining('--git-common-dir').hold = held

    const seen: GitRepositoryState[] = []
    const release = gitState.attach(gitState.resolve({ path: repoDir }), state => seen.push(state))
    await vi.waitFor(() => {
      expect(seen).toEqual([{ type: 'named-branch', branch: 'master' }])
    })
    release() // the placement continuation is still awaiting the gated query
    unhold?.()
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 4)
    })
    // Released before membership: no repository watch was ever left behind.
    expect(gitState.watchTargets.filter(target => target === nodePath.join(repoDir, '.git'))).toHaveLength(0)
  })

  it('skips a member released while its re-resolution pass is in flight', async () => {
    const gitState = await setup()
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen.length).toBe(1)
    })

    let unhold: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      unhold = resolve
    })
    subprocess().scriptContaining('--git-dir').hold = held
    onBranch('mid-flight')
    writeHead('ref: refs/heads/mid-flight\n')
    // Wait until the debounced pass is parked on the gated probe.
    const before = subprocess().consumed
    await vi.waitFor(() => {
      expect(subprocess().consumed).toBe(before + 1)
    })
    release()
    unhold?.()
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 5)
    })
    expect(lastOf(seen)).toEqual({ type: 'named-branch', branch: 'master' })
  })
})

describe('state-kind comparisons across re-resolutions', () => {
  it('repeatedly resolving a no-repository directory stays silent', async () => {
    const gitState = await setup()
    discoveryFails()
    const { seen } = collect(gitState, plainDir)
    await vi.waitFor(() => {
      expect(seen).toEqual([{ type: 'no-repository' }])
    })
    const before = subprocess().consumed
    fs.writeFileSync(nodePath.join(plainDir, 'touch'), '')
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 4)
    })
    // The second pass ran (one extra --git-dir probe per member) but reported nothing.
    expect(subprocess().consumed - before).toBe(1)
    expect(seen).toHaveLength(1)
  })

  it('compares detached states by commit across passes', async () => {
    const gitState = await setup()
    const shortScript = subprocess().scriptContaining('--short')
    branchScript.stdout = 'HEAD\n'
    shortScript.exitCode = 0
    shortScript.stdout = '4f2a9c1\n'
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen).toEqual([{ type: 'detached', commit: '4f2a9c1' }])
    })

    // Same detached commit rewritten byte-wise → suppressed.
    writeHead('4f2a9c1\n')
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 4)
    })
    expect(seen).toHaveLength(1)

    // A different abbreviated commit → reported.
    shortScript.stdout = '9b8c7d6\n'
    writeHead('9b8c7d6\n')
    await vi.waitFor(() => {
      expect(lastOf(seen)).toEqual({ type: 'detached', commit: '9b8c7d6' })
    })
    release()
  })

  it('compares unavailable states by reason across polls', async () => {
    const gitState = await setup()
    const ghost = nodePath.join(world, 'ghost')
    const { seen } = collect(gitState, ghost)
    // Registration fails on the missing target, so this entry lives on the poll fallback.
    await vi.waitFor(() => {
      expect(seen.length).toBe(1)
    })
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS * 3)
    })
    expect(seen).toHaveLength(1) // identical reason → suppressed

    fs.writeFileSync(ghost, 'x') // becomes a non-directory
    await vi.waitFor(() => {
      expect(seen).toHaveLength(2)
      if (seen[1] !== undefined && seen[1].type === 'unavailable') {
        expect(seen[1].reason).toContain('is not a directory')
      }
    }, { timeout: POLL_MS * 8 })
  })
})

describe('anchoring degradation', () => {
  it('falls back to directory watching when repository metadata queries fail during placement', async () => {
    const gitState = (await setup(InstrumentedGitState)) as InstrumentedGitState
    subprocess().scriptContaining('--git-common-dir').exitCode = 128
    const { seen, release } = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(seen).toEqual([{ type: 'named-branch', branch: 'master' }])
    })
    // Anchored on the directory itself, not on repository metadata.
    expect(gitState.watchTargets.filter(target => target === nodePath.join(repoDir, '.git'))).toHaveLength(0)
    expect(gitState.watchTargets.filter(target => target === repoDir)).toHaveLength(1)

    // A directory-level event still drives re-resolution while degraded.
    const before = subprocess().consumed
    fs.writeFileSync(nodePath.join(repoDir, 'marker'), '')
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 4)
    })
    expect(subprocess().consumed).toBeGreaterThan(before)
    release()
  })
})

describe('re-resolution over mixed-liveness members', () => {
  it('skips an already-released member without disturbing its siblings', async () => {
    const gitState = await setup()
    const a = collect(gitState, repoDir)
    const b = collect(gitState, repoDir)
    await vi.waitFor(() => {
      expect(a.seen.length).toBe(1)
    })
    await vi.waitFor(() => {
      expect(b.seen.length).toBe(1)
    })

    // Park the pass on the FIRST member's branch query, release the SECOND
    // sibling meanwhile, then resume: the loop must skip the released member
    // at its turn without disturbing the live one.
    let unhold: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      unhold = resolve
    })
    subprocess().scriptContaining('--abbrev-ref').hold = held

    onBranch('mixed')
    writeHead('ref: refs/heads/mixed\n')
    const before = subprocess().consumed
    await vi.waitFor(() => {
      expect(subprocess().consumed).toBe(before + 2)
    }) // parked on a's abbrev-ref
    b.release()
    unhold?.()
    await vi.waitFor(() => {
      expect(lastOf(a.seen)).toEqual({ type: 'named-branch', branch: 'mixed' })
    })
    expect(lastOf(b.seen)).toEqual({ type: 'named-branch', branch: 'master' })
    a.release()
  })
})

describe('release racing the first resolution', () => {
  it('silently drops an observation released before its first resolution completes', async () => {
    const gitState = await setup()
    const seen: GitRepositoryState[] = []
    const release = gitState.attach(gitState.resolve({ path: repoDir }), state => seen.push(state))
    release()
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 5)
    })
    expect(seen).toEqual([])
  })
})

describe('Host shutdown with observations outstanding', () => {
  it('releases every watcher and timer at disposal without blocking', async () => {
    const gitState = await setup()
    const fake = subprocess()
    const { seen } = collect(gitState, repoDir)
    const other = collect(gitState, plainDir)
    await vi.waitFor(() => {
      expect(seen.length).toBe(1)
    })
    await vi.waitFor(() => {
      expect(other.seen.length).toBe(1)
    })

    const consumedBeforeDispose = fake.consumed
    await (ctx as Context).fiber.dispose()
    onBranch('post-shutdown')
    writeHead('ref: refs/heads/post-shutdown\n')
    await new Promise((resolve) => {
      setTimeout(resolve, DEBOUNCE_MS * 6)
    })
    expect(fake.consumed).toBe(consumedBeforeDispose)
    expect(seen).toHaveLength(1)
  })
})

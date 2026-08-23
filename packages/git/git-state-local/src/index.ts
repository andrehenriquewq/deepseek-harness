/**
 * Local Service Provider for the Git repository-state capability seam over
 * the subprocess capability seam. Resolution delegates every question to the
 * `git` binary (`rev-parse`) spawned through `ctx.subprocess`, so linked
 * worktrees, packed refs, and commondir indirection resolve without parsing
 * repository files by hand. Change detection watches the resolved `HEAD`
 * file and falls back to interval re-resolution wherever watching is
 * unavailable. Resolution and observation never write to the repository.
 * @module @deepseek-ai/dsh-git-state-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GitStateService } from '@deepseek-ai/dsh-git-state'
import type { GitRepositoryState, GitStateObserver, GitStateRequest, GitStateSpec, GitUnavailable } from '@deepseek-ai/dsh-git-state'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'

/** Fixed deadline for one `git rev-parse` invocation; resolution is milliseconds-scale, so this bounds pathology, not tunable latency. */
const RESOLUTION_DEADLINE_MS = 10_000

/** Fixed SIGTERM→SIGKILL grace for the read-only `git` children this provider spawns. */
const RESOLUTION_GRACE_MS = 1_000

/** Per-stream collected-output cap; `rev-parse` answers are single short lines. */
const GIT_OUTPUT_MAX_BYTES = 4_096

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Debounce coalescing filesystem watch events before re-resolution. */
  watchDebounceMs?: number
  /** Interval of the polling fallback used for repositories whose watching is unavailable. */
  pollIntervalMs?: number
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`git-state-local: ${name} must be a positive finite number`)
  }
}

/**
 * Reject a resolved section this provider could not run with. The schema
 * expresses neither "positive and finite" nor the timer bound both fields
 * have to fit, so a stored value is refused where it is written instead of
 * failing at the first observed change.
 * @param config - the resolved section, schema-valid by construction.
 * @throws Error naming the field that cannot be used.
 */
export function assertServiceableGitStateConfig(config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('watchDebounceMs', resolved.watchDebounceMs)
  assertPositiveFinite('pollIntervalMs', resolved.pollIntervalMs)
  if (resolved.watchDebounceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`git-state-local: watchDebounceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (resolved.pollIntervalMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`git-state-local: pollIntervalMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** One settled `git` invocation, output trimmed of nothing (caller trims). */
interface GitInvocation {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** Which resource anchors an entry's watching: repository metadata, or the plain directory until a repository appears. */
type AnchorKind = 'repository' | 'directory'

interface Observation {
  /** Absolute directory under observation (the resolved spec path). */
  readonly path: string
  observer: GitStateObserver
  last: GitRepositoryState | undefined
  entry: RepoEntry | undefined
  /** Anchor class of {@link last} at placement time; a class change re-keys the observation. */
  anchorKind: AnchorKind | undefined
  disposed: boolean
}

/**
 * One shared observation unit keyed by resolved Git common directory (or by
 * the observed directory itself while no repository is there). Every member
 * shares the watchers and the re-resolution pipeline; the entry lives while
 * at least one member holds it.
 */
interface RepoEntry {
  readonly key: string
  members: Set<Observation>
  /** Live filesystem watchers by watched path (`HEAD` files, or the directory itself). */
  readonly watchers: Map<string, fs.FSWatcher>
  debounce: NodeJS.Timeout | undefined
  poll: NodeJS.Timeout | undefined
}

function classOf(state: GitRepositoryState): AnchorKind {
  return state.type === 'named-branch' || state.type === 'detached' ? 'repository' : 'directory'
}

function unavailable(reason: string): GitUnavailable {
  return { type: 'unavailable', reason }
}

function messageOf(error: unknown): string {
  return String(error)
}

function statesEqual(a: GitRepositoryState, b: GitRepositoryState): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'named-branch': return b.type === 'named-branch' && a.branch === b.branch
    case 'detached': return b.type === 'detached' && a.commit === b.commit
    case 'no-repository': return true
    default: return b.type === 'unavailable' && a.reason === b.reason
  }
}


/**
 * Local Git repository-state service over `ctx.subprocess`. Watchers are
 * reference-counted per resolved common directory, so callers sharing a
 * working tree share one watcher and one re-resolution pass; each caller
 * still receives its own notifications.
 */
export class LocalGitStateService extends GitStateService {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    watchDebounceMs: z.number().default(150),
    pollIntervalMs: z.number().default(5_000),
  })

  private readonly _config: ResolvedConfig
  private readonly entries = new Map<string, RepoEntry>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery fills these fields before construction; the type does not encode that step.
    const entry = config as ResolvedConfig
    assertServiceableGitStateConfig(entry)
    this._config = entry
    // Synchronous teardown: closing watchers and clearing timers cannot block
    // Host shutdown, so disposal releases everything outstanding immediately.
    ctx.effect(() => () => {
      this.releaseAll()
    }, 'git-state-local: release watchers and timers')
  }

  resolve(request: GitStateRequest): GitStateSpec {
    return { path: nodePath.resolve(request.path) }
  }

  async run(spec: GitStateSpec): Promise<GitRepositoryState> {
    return this.resolveStatePath(spec.path)
  }

  attach(spec: GitStateSpec, observer: GitStateObserver): () => void {
    const observation: Observation = {
      path: spec.path,
      observer,
      last: undefined,
      entry: undefined,
      anchorKind: undefined,
      disposed: false,
    }
    void this.introduce(observation)
    return () => {
      this.releaseObservation(observation)
    }
  }

  /**
   * Resolve one absolute directory to exactly one determinate state, mapping
   * every failure mode onto `no-repository` or `unavailable` instead of throwing.
   *
   * Repository discovery (`--git-dir`) runs before HEAD resolution so the two
   * failures stay distinguishable: Git reports a plain non-repository and a
   * corrupt repository with overlapping messages, but discovery still succeeds
   * when only HEAD is unreadable — that combination is the corrupt case.
   */
  /**
   * Resolve one absolute directory to exactly one determinate state.
   * @param path - absolute directory to inspect.
   * @returns exactly one determinate state; never rejects.
   */
  async resolveStatePath(path: string): Promise<GitRepositoryState> {
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(path)
    } catch (error) {
      return unavailable(`cannot read "${path}": ${messageOf(error)}`)
    }
    if (!stat.isDirectory()) return unavailable(`"${path}" is not a directory`)
    const dir = await this.runGit(['rev-parse', '--git-dir'], path)
    if (dir === undefined) return unavailable('the git executable could not be executed in this environment')
    if (dir.exitCode !== 0) {
      if (/not a git repository|not a working tree/i.test(`${dir.stderr} ${dir.stdout}`)) {
        // A local .git entry that Git refuses to interpret is corruption, not absence:
        // the state stays determinate and never fabricates a branch name.
        let gitEntry: fs.Stats | undefined
        try {
          gitEntry = await fs.promises.stat(nodePath.join(path, '.git'))
        } catch {
          // No local .git entry at this directory: genuinely outside any repository.
        }
        if (gitEntry !== undefined) return unavailable(`repository metadata is unreadable: ${firstLine(dir.stderr)}`)
        return { type: 'no-repository' }
      }
      return unavailable(`git rev-parse failed: ${firstLine(dir.stderr)}`)
    }
    const head = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], path)
    if (head === undefined) return unavailable('the git executable could not be executed in this environment')
    if (head.exitCode === 0) {
      const ref = head.stdout.trim()
      // `--abbrev-ref HEAD` prints the literal marker "HEAD" for a detached checkout;
      // the tag distinguishes the state, so callers never parse the identifier.
      if (ref !== 'HEAD') return { type: 'named-branch', branch: ref }
      const commit = await this.runGit(['rev-parse', '--short', 'HEAD'], path)
      if (commit !== undefined && commit.exitCode === 0 && commit.stdout.trim().length > 0) {
        return { type: 'detached', commit: commit.stdout.trim() }
      }
      return unavailable(commit === undefined
        ? 'the git executable could not be executed in this environment'
        : `detached HEAD commit is unreadable: ${firstLine(commit.stderr)}`)
    }
    return unavailable(`repository metadata is unreadable: ${firstLine(head.stderr)}`)
  }

  /**
   * Run one read-only `git rev-parse` invocation. Collects bounded output and
   * resolves `undefined` only when git itself cannot be executed (spawn-level failure).
   */
  /**
   * Run one read-only `git rev-parse` invocation with bounded collected output.
   * @param argv - arguments after the leading `git`.
   * @param cwd - working directory for the invocation.
   * @returns the settled invocation, or undefined when git cannot be executed.
   */
  async runGit(argv: readonly string[], cwd: string): Promise<GitInvocation | undefined> {
    // A continuation resuming after composition disposal finds the subprocess
    // service gone; that maps onto the unavailable state instead of throwing
    // across teardown.
    const subprocess = this.ctx.subprocess as SubprocessRuntime | undefined
    if (subprocess === undefined) return undefined
    const collect = (): { maxBytes: number } => ({ maxBytes: GIT_OUTPUT_MAX_BYTES })
    using d = deadline(undefined, RESOLUTION_DEADLINE_MS, 'GIT_STATE_RESOLUTION_TIMEOUT')
    const handle = subprocess.spawn({
      argv: ['git', ...argv],
      cwd,
      stdio: { stdin: 'ignore', stdout: collect(), stderr: collect() },
      graceMs: RESOLUTION_GRACE_MS,
      signal: d.signal,
    })
    try {
      const outcome = await handle.done
      return {
        exitCode: outcome.exitCode,
        stdout: LocalGitStateService.collectedOutput(handle, 'stdout'),
        stderr: LocalGitStateService.collectedOutput(handle, 'stderr'),
      }
    } catch {
      // Spawn-level failure (git missing/unusable) is a determinate outcome here:
      // the caller maps it onto the unavailable state rather than throwing to ITS caller.
      return undefined
    }
  }

  /** The collect-mode reader the spawn requested (present by the seam contract). */
  private static collectedOutput(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): string {
    const reader = handle.collected[stream]
    /* v8 ignore start -- collect dispositions expose the reader by the seam contract; defensive. */
    if (reader === undefined) {
      throw new Error(`git-state-local: subprocess implementation dropped the requested ${stream} stream`)
    }
    /* v8 ignore stop */
    return reader.readFrom(0).text
  }

  /**
   * Determine an observation's anchoring resources from its current state:
   * a repository keys the entry by common directory and watches its `HEAD`;
   * any other state watches the directory itself so a later `git init` there
   * is seen.
   */
  /**
   * Determine an observation's anchoring resources from its current state.
   * @param path - absolute observed directory.
   * @param state - its currently resolved state.
   * @returns the entry key, anchor kind, and paths to watch.
   */
  async anchorFor(path: string, state: GitRepositoryState): Promise<{ key: string; kind: AnchorKind; targets: string[] }> {
    if (state.type === 'named-branch' || state.type === 'detached') {
      const common = await this.runGit(['rev-parse', '--git-common-dir'], path)
      const dir = await this.runGit(['rev-parse', '--git-dir'], path)
      if (common?.exitCode === 0 && dir?.exitCode === 0) {
        const commonDir = absoluteDirectory(path, common.stdout.trim())
        const gitDir = absoluteDirectory(path, dir.stdout.trim())
        // Watch the GIT-DIR DIRECTORY, not the HEAD file: Git updates HEAD
        // atomically (lock file + rename), which silently detaches a
        // file-targeted watch on some platforms; a directory watch sees every
        // replacement, and the debounce absorbs unrelated metadata churn.
        return { key: commonDir, kind: 'repository', targets: [gitDir] }
      }
      // A repository resolved moments ago but metadata now fails: fall through to
      // directory anchoring so the next event still triggers re-resolution.
    }
    return { key: path, kind: 'directory', targets: [path] }
  }

  /**
   * Resolve once, report, then place onto anchoring resources.
   * @param observation - the freshly attached observation.
   */
  async introduce(observation: Observation): Promise<void> {
    const state = await this.resolveStatePath(observation.path)
    if (observation.disposed) return
    observation.last = state
    this.notify(observation, state)
    await this.place(observation, state)
  }

  /** Move an observation onto the resources its current state requires. */
  /**
   * Move an observation onto the resources its current state requires.
   * @param observation - observation to place.
   * @param state - its current resolved state.
   */
  async place(observation: Observation, state: GitRepositoryState): Promise<void> {
    const anchor = await this.anchorFor(observation.path, state)
    if (observation.disposed) return
    const entry = this.entryFor(anchor.key)
    entry.members.add(observation)
    observation.entry = entry
    observation.anchorKind = anchor.kind
    for (const target of anchor.targets) this.ensureWatch(entry, target)
  }

  /**
   * Deliver one state to an observer, containing callback faults.
   * @param observation - observing caller.
   * @param state - state to report.
   */
  notify(observation: Observation, state: GitRepositoryState): void {
    try {
      observation.observer(state)
    } catch {
      // Observer faults stay contained: the shared re-resolution pipeline must
      // survive one caller's throwing callback, which only that caller can fix.
    }
  }

  /**
   * Get or create the shared entry for one anchor key.
   * @param key - anchor key (common directory or plain directory).
   * @returns the live entry for the key.
   */
  entryFor(key: string): RepoEntry {
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing
    const created: RepoEntry = { key, members: new Set(), watchers: new Map(), debounce: undefined, poll: undefined }
    this.entries.set(key, created)
    return created
  }

  /**
   * Ensure exactly one watch per target, creating it off the current call stack.
   * @param entry - owning entry.
   * @param target - file or directory path to watch.
   */
  ensureWatch(entry: RepoEntry, target: string): void {
    if (entry.poll !== undefined || entry.watchers.has(target)) return
    // Reserve the slot SYNCHRONOUSLY so concurrent attachers share one
    // registration; the real watcher is created off the current call stack
    // (see below).
    entry.watchers.set(target, RESERVED_WATCHER)
    setImmediate(() => {
      if (entry.poll !== undefined || !this.entries.has(entry.key)) return
      entry.watchers.delete(target)
      try {
        const watcher = this.startWatch(
          target,
          () => {
            this.scheduleResolve(entry)
          },
          () => {
            this.degradeToPolling(entry)
          },
        )
        entry.watchers.set(target, watcher)
      } catch {
        // Watching is unavailable here (sandboxed deployment, or the target
        // does not exist yet): degrade to interval re-resolution instead of
        // losing updates.
        entry.watchers.delete(target)
        this.degradeToPolling(entry)
      }
    })
  }

  /**
   * Start one filesystem watch delivering change and error notifications.
   * Overridable so embedding runtimes can route watching through their own
   * substrate (the {@link LocalBashExecutor.runArgv} seam pattern).
   * @param target - file or directory path to watch.
   * @param onEvent - invoked per filesystem event, regardless of event kind.
   * @param onError - invoked when the watch itself fails at runtime.
   * @returns the live watcher handle, closed by the service at teardown.
   */
  protected startWatch(target: string, onEvent: () => void, onError: () => void): fs.FSWatcher {
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(target, { persistent: false, recursive: true }, () => {
        onEvent()
      })
    } catch {
      // Platforms without recursive watching (Linux) reject the option up
      // front; the flat watch still covers direct children.
      watcher = fs.watch(target, { persistent: false }, () => {
        onEvent()
      })
    }
    watcher.on('error', onError)
    return watcher
  }

  /**
   * Replace a failed or impossible watch with interval re-resolution for this
   * repository only; other repositories keep event-driven updates.
   */
  /**
   * Replace failed or impossible watching with interval re-resolution.
   * @param entry - the entry whose watching is unavailable.
   */
  degradeToPolling(entry: RepoEntry): void {
    if (entry.poll !== undefined) return
    for (const watcher of entry.watchers.values()) watcher.close()
    entry.watchers.clear()
    entry.poll = setInterval(() => void this.reresolveEntry(entry), this._config.pollIntervalMs)
    entry.poll.unref()
  }

  /** Coalesce bursts of filesystem events (Git writes HEAD more than once per operation) into one re-resolution. */
  /**
   * Arm or reset the debounced re-resolution for one entry.
   * @param entry - entry whose members should be re-resolved after the debounce.
   */
  scheduleResolve(entry: RepoEntry): void {
    if (entry.debounce !== undefined) clearTimeout(entry.debounce)
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined
      void this.reresolveEntry(entry)
    }, this._config.watchDebounceMs)
    entry.debounce.unref()
  }

  /**
   * Re-resolve every member of one entry and report transitions; an
   * observation whose state class changed re-keys onto fresh anchoring
   * resources (e.g. a directory becoming a repository).
   */
  /**
   * Re-resolve every member of one entry and report transitions.
   * @param entry - the entry whose members are re-resolved.
   */
  async reresolveEntry(entry: RepoEntry): Promise<void> {
    // A destroyed entry holds only disposed or migrated members, so every
    // iteration below skips and the trailing sweep re-runs idempotently.
    for (const observation of [...entry.members]) {
      if (observation.disposed || observation.entry !== entry) continue
      const state = await this.resolveStatePath(observation.path)
      if (observation.entry !== entry) continue
      // introduce() assigns `last` before the observation gains entry membership,
      // so every re-resolution observes a previously reported state.
      const previous = observation.last as GitRepositoryState
      const changed = !statesEqual(state, previous)
      observation.last = state
      if (changed) this.notify(observation, state)
      if (classOf(state) !== observation.anchorKind) {
        entry.members.delete(observation)
        observation.entry = undefined
        await this.place(observation, state)
      }
    }
    if (entry.members.size === 0) this.destroyEntry(entry)
  }

  /**
   * Release one observation and destroy its entry when it was the last member.
   * @param observation - the observation being released.
   */
  releaseObservation(observation: Observation): void {
    observation.disposed = true
    const entry = observation.entry
    if (entry === undefined) return
    observation.entry = undefined
    entry.members.delete(observation)
    if (entry.members.size === 0) this.destroyEntry(entry)
  }

  /**
   * Close every watcher and timer of one entry and drop it from the registry.
   * @param entry - the entry to destroy.
   */
  destroyEntry(entry: RepoEntry): void {
    if (entry.debounce !== undefined) {
      clearTimeout(entry.debounce)
      entry.debounce = undefined
    }
    if (entry.poll !== undefined) {
      clearInterval(entry.poll)
      entry.poll = undefined
    }
    for (const watcher of entry.watchers.values()) watcher.close()
    entry.watchers.clear()
    this.entries.delete(entry.key)
  }

  /**
   * Release every entry: synchronous, so shutdown never waits on I/O. Members
   * are marked disposed so an in-flight re-resolution continuation that
   * resumes after teardown reports nothing.
   */
  private releaseAll(): void {
    for (const entry of [...this.entries.values()]) {
      for (const observation of entry.members) observation.disposed = true
      this.destroyEntry(entry)
    }
  }
}

/** Placeholder occupying a watcher slot between reservation and deferred creation. */
const RESERVED_WATCHER = {
  close: (): void => {},
  on: (): void => {},
} as unknown as fs.FSWatcher

function absoluteDirectory(base: string, output: string): string {
  return nodePath.isAbsolute(output) ? output : nodePath.resolve(base, output)
}

function firstLine(text: string): string {
  // String.prototype.split always yields at least one element.
  const line = text.trim().split('\n')[0] as string
  return line.length > 0 ? line : 'no diagnostic output'
}

export default LocalGitStateService

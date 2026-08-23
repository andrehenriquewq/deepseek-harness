import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** One scripted `git` invocation outcome. */
export interface ScriptedGit {
  /** argv after the leading `git`, matched exactly (e.g. `['rev-parse', '--git-dir']`). */
  argvTail: readonly string[]
  exitCode: number
  stdout?: string
  stderr?: string
  /** Make `done` reject instead, simulating a spawn-level failure. */
  failSpawn?: boolean
  /**
   * Hold the settled outcome until this promise resolves, so tests can act
   * (release an observation) between spawn and completion.
   */
  hold?: Promise<void>
}

/** Scripts staged for the next FakeSubprocess mount (cordis constructs plugins itself). */
let pendingScripts: readonly ScriptedGit[] = []

/**
 * Stage scripts the NEXT {@link FakeSubprocess} mount will answer with; call
 * before `ctx.plugin(FakeSubprocess)`.
 */
export function stageFakeScripts(...scripts: readonly ScriptedGit[]): void {
  pendingScripts = scripts
}

export interface RecordedSpawn {
  argv: readonly string[]
  cwd: string
}

function scriptedHandle(script: ScriptedGit | undefined, spec: SubprocessSpawnSpec): SubprocessHandle {
  const stdout = script?.stdout ?? ''
  const stderr = script?.stderr ?? ''
  const reader = (text: string): SubprocessOutputReader => ({
    readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }),
  })
  const outcome: SubprocessOutcome = { exitCode: script?.exitCode ?? 1, signal: null }
  const settle = (): Promise<SubprocessOutcome> =>
    script?.failSpawn === true ? Promise.reject(new Error(`spawn ${spec.argv[0]} ENOENT`)) : Promise.resolve(outcome)
  const done = script?.hold === undefined ? settle() : script.hold.then(settle)
  return {
    pid: 4242,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    done,

    terminate: () => {},
    waitForExit: async () => true,
  }
}

/**
 * Scripted subprocess runtime: `git` invocations are answered from the first
 * matching script (matched in registration order by exact argv tail), so tests
 * control every failure mode without a real binary. Matched scripts stay
 * installed — state queries repeat across re-resolutions, and tests mutate a
 * script's fields between phases to move the scripted state. Unmatched
 * invocations fail loudly.
 *
 * Mount after calling {@link stageFakeScripts}; retrieve via `ctx.subprocess`.
 */
export class FakeSubprocess extends SubprocessRuntime {
  /** Invocations in spawn order. */
  readonly calls: RecordedSpawn[] = []
  /** Registered scripts; tests mutate entries in place to change scripted answers. */
  readonly scripts: ScriptedGit[] = []

  constructor(ctx: Context) {
    super(ctx)
    this.scripts.push(...pendingScripts)
    pendingScripts = []
  }

  /** Number of invocations answered so far — the resolution-pass counter for dedup assertions. */
  get consumed(): number {
    return this.calls.length
  }

  /** The registered script whose argv tail contains every given part (e.g. '--git-common-dir'). */
  scriptContaining(...parts: readonly string[]): ScriptedGit {
    const found = this.scripts.find(script => parts.every(part => script.argvTail.includes(part)))
    if (found === undefined) throw new Error(`FakeSubprocess: no script matching ${JSON.stringify(parts)}`)
    return found
  }

  async resolveExecutable(command: string): Promise<string> {
    return command === 'git' ? '/usr/bin/git' : command
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls.push({ argv: spec.argv, cwd: spec.cwd })
    const argvTail = spec.argv.slice(1)
    const script = this.scripts.find(candidate => candidate.argvTail.length === argvTail.length
      && candidate.argvTail.every((part, i) => part === argvTail[i]))
    if (script === undefined) {
      throw new Error(`FakeSubprocess: no script for argv ${JSON.stringify(spec.argv)} in ${spec.cwd}`)
    }
    return scriptedHandle(script, spec)
  }

  async spawnTerminal(): Promise<never> {
    throw new Error('FakeSubprocess: terminal allocation is not part of this seam test')
  }
}

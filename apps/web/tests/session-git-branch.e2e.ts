// Web e2e scenario: the session-header Git branch chip.
//
// The chip reads Host-pushed repository state for live sessions' cwd values,
// so this scenario makes the scaffold's workspace a real Git repository
// BEFORE seeding its session, then walks the three product states: named
// branch, detached HEAD (the agent checking out mid-session is the motivating
// case — the update arrives through the live watch, not a reload), and no
// repository at all (the header must lay out as though the branch had never
// been present).
//
// Zero model calls: no replay fixture mounts, so a stray stream fails loud.
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/session-git-branch', import.meta.url))
const BRANCH_EXPECTED = join(SNAPSHOT_DIR, 'branch.expected.md')
const DETACHED_EXPECTED = join(SNAPSHOT_DIR, 'detached.expected.md')
const NONE_EXPECTED = join(SNAPSHOT_DIR, 'none.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'session-git-branch-web-e2e'
// Refresh mode writes goldens; the directory must exist first.
import { mkdirSync } from 'node:fs'
mkdirSync(SNAPSHOT_DIR, { recursive: true })

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'scaffold',
  GIT_AUTHOR_EMAIL: 'scaffold@localhost',
  GIT_COMMITTER_NAME: 'scaffold',
  GIT_COMMITTER_EMAIL: 'scaffold@localhost',
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Minimal closed recording: one committed turn, so resume has nothing to repair. */
function seedLog(): string {
  const time = 1784974100000
  const at = (index: number, event: Record<string, unknown>): string =>
    JSON.stringify({ ...event, seq: index, time: time + index })
  return [
    JSON.stringify({ type: 'session', version: 0, id: '{{sessionId}}', createdAt: time }),
    at(0, { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } } }),
    at(1, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Seeded turn.' }], source: { kind: 'user', rpcId: 'seed' } },
      surfaceOp: 'append',
    }),
    at(2, { type: 'session/title', data: { title: 'Seeded turn', messageSeqs: [1], source: { kind: 'fallback' } } }),
    at(3, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n')
}

async function openSeededSession(page: Page): Promise<void> {
  await page.getByRole('treeitem', { name: /^Ungrouped/ }).click()
  await page.locator('[role="treeitem"]').last().click()
  await page.getByText('Seeded turn.').waitFor({ timeout: 15_000 })
}

describe('web e2e: session git branch chip', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Deliberately NOT a repository yet: the seeded session starts in the
    // no-branch state, and `git init` below is itself one of the transitions
    // under test (a directory becoming a repository while observed).
    await seedSession(scaffold, seedLog(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    rmSync(scaffold?.workspaceCwd ?? '', { recursive: true, force: true })
  })

  it('renders nothing while the working tree is not a repository', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-git-none'))
    await openSeededSession(page)

    const snapshot = await captureStableAria(page, '[class*="titleRow"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(NONE_EXPECTED, snapshot, MODE)
    expect(snapshot).not.toContain('main')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('shows the branch once the directory becomes a repository', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-git-branch'))
    git(scaffold.workspaceCwd, ['init', '-q', '--initial-branch=main', '.'])
    execFileSync('sh', ['-c', 'echo one > tracked.txt'], { cwd: scaffold.workspaceCwd })
    git(scaffold.workspaceCwd, ['add', '.'])
    git(scaffold.workspaceCwd, ['commit', '-q', '-m', 'init'])

    await expect.poll(async () => {
      const snapshot = await captureStableAria(page, '[class*="titleRow"]', scaffold.workspaceCwd)
      return snapshot.includes('main') ? 'branch' : 'absent'
    }, { timeout: 20_000, interval: 500 }).toBe('branch')

    const snapshot = await captureStableAria(page, '[class*="titleRow"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(BRANCH_EXPECTED, snapshot, MODE)
    // Static context, not a control.
    expect(snapshot).not.toContain('button "main"')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('follows a checkout --detach without any user action', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-git-detached'))
    git(scaffold.workspaceCwd, ['checkout', '--detach', 'HEAD'])
    // The abbreviated commit is per-run; normalize it out of the golden.
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: scaffold.workspaceCwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim()

    await expect.poll(async () => {
      const snapshot = await captureStableAria(page, '[class*="titleRow"]', scaffold.workspaceCwd)
      return snapshot.includes('Detached HEAD') ? 'detached' : snapshot
    }, { timeout: 20_000, interval: 500 }).toBe('detached')

    const raw = await captureStableAria(page, '[class*="titleRow"]', scaffold.workspaceCwd)
    const snapshot = raw.split(commit).join('<COMMIT>')
    await compareOrRefreshGolden(DETACHED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})

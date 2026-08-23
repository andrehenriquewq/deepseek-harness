// @vitest-environment jsdom
/**
 * The chip's presentation contract: branch identity with the distinguishing
 * glyph, detached marking, silent degradation for every no-branch state, and
 * the truncation affordances (CSS ellipsis plus full-name title).
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { GitStateSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { GitRepositoryState } from '@deepseek-ai/dsh-client-connection/client'
import { GitBranchLabel } from '../src/client/GitBranchLabel.tsx'
import type { GitBranchLabelProps } from '../src/client/GitBranchLabel.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** Build both framework hooks over hand-built snapshots, then render the chip. */
function renderChip(
  session: { cwd?: string } | undefined,
  git: Record<string, GitRepositoryState>,
) {
  const byId: Record<string, { cwd?: string }> = { s1: {} }
  if (session !== undefined && typeof session.cwd === 'string') byId['s1'] = { cwd: session.cwd }
  const sessions = createSnapshotStore<{ ids: string[]; byId: Record<string, { cwd?: string }> }>({
    ids: ['s1'],
    byId,
  })
  const gitStates = createSnapshotStore<GitStateSnapshot>({ entries: git })
  return render(<GitBranchLabel {...({
    sessionId: 's1',
    useSessions: bindSnapshotSelector(sessions as unknown as SnapshotStore<never>),
    useGitStates: bindSnapshotSelector(gitStates as unknown as SnapshotStore<never>),
    t: (key: 'hint' | 'detachedHead') => en[key],
  } as unknown as GitBranchLabelProps)} />)
}

describe('the session-header branch chip', () => {
  it('names a named branch with the branch glyph and hint title', () => {
    const { container } = renderChip({ cwd: '/repo' }, { '/repo': { type: 'named-branch', branch: 'feat/example' } })
    expect(screen.getByText('feat/example')).toBeTruthy()
    // The glyph is the version-control marker; it survives any branch text.
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.getByTitle(en.hint)).toBeTruthy()
    expect(screen.queryByText(en.detachedHead)).toBeNull()
  })

  it('keeps the marker for a branch literally named like a commit identifier', () => {
    const { container } = renderChip({ cwd: '/repo' }, { '/repo': { type: 'named-branch', branch: 'b150a55' } })
    expect(screen.getByText('b150a55')).toBeTruthy()
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('marks a detached HEAD distinctly from an equal-looking branch name', () => {
    const { container } = renderChip({ cwd: '/repo' }, { '/repo': { type: 'detached', commit: '4f2a9c1' } })
    expect(screen.getByText('4f2a9c1')).toBeTruthy()
    expect(screen.getByText(en.detachedHead)).toBeTruthy()
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('detached')
    expect(root.getAttribute('title')).toBe(`${en.detachedHead} · 4f2a9c1`)
    expect(root.getAttribute('aria-label')).toBe(`${en.detachedHead} 4f2a9c1`)
  })

  it('renders nothing — not even reserved width — for every absent state', () => {
    for (const entry of [
      undefined,
      { type: 'no-repository' },
      { type: 'unavailable', reason: 'cannot read' },
    ] as GitRepositoryState[] | undefined[]) {
      const git: Record<string, GitRepositoryState> = {}
      if (entry !== undefined) git['/repo'] = entry
      const { container } = renderChip({ cwd: '/repo' }, git)
      expect(container.firstElementChild).toBeNull()
    }
  })

  it('renders nothing for a session without a working directory', () => {
    const { container } = renderChip(undefined, {})
    expect(container.firstElementChild).toBeNull()
  })

  it('carries the full name in its title while CSS truncates the display', () => {
    const long = 'feat/very-long-branch-name-that-certainly-overflows-the-header'
    const { container } = renderChip({ cwd: '/repo' }, { '/repo': { type: 'named-branch', branch: long } })
    const root = container.firstElementChild as HTMLElement
    const name = root.querySelector('span[class*="name"]') as HTMLElement
    expect(name.textContent).toBe(long)
    // Hover and keyboard focus read the same native tooltip; no activation affordance exists.
    expect(root.getAttribute('title')).toBe(en.hint)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('follows a mid-session branch change through the store', () => {
    const gitStates = createSnapshotStore<GitStateSnapshot>({ entries: {} })
    const sessions = createSnapshotStore<{ ids: string[]; byId: Record<string, { cwd?: string }> }>({
      ids: ['s1'], byId: { s1: { cwd: '/repo' } },
    })
    const { getByText, rerender } = render(<GitBranchLabel {...({
      sessionId: 's1',
      useSessions: bindSnapshotSelector(sessions as unknown as SnapshotStore<never>),
      useGitStates: bindSnapshotSelector(gitStates as unknown as SnapshotStore<never>),
      t: (key: 'hint' | 'detachedHead') => en[key],
    } as unknown as GitBranchLabelProps)} />)
    expect(document.querySelector('[class*="label"]')).toBeNull()

    // The agent checks out feat/live mid-session; only the store moves.
    gitStates.set({ entries: { '/repo': { type: 'named-branch', branch: 'feat/live' } } })
    rerender(<GitBranchLabel {...({
      sessionId: 's1',
      useSessions: bindSnapshotSelector(sessions as unknown as SnapshotStore<never>),
      useGitStates: bindSnapshotSelector(gitStates as unknown as SnapshotStore<never>),
      t: (key: 'hint' | 'detachedHead') => en[key],
    } as unknown as GitBranchLabelProps)} />)
    expect(getByText('feat/live')).toBeTruthy()
  })
})

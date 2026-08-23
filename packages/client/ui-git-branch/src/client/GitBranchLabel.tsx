/**
 * The session header's Git branch chip.
 *
 * Presentation-only by construction: branch state arrives from the Host's
 * repository-state frames, renders beside the title in the static
 * session-context band, and never enters a model request or the session log.
 * Every state that is not a branch — no repository, unreadable, still
 * resolving — renders nothing at all, so the header lays out exactly as it
 * did before this chip existed (the common non-repository case stays visually
 * identical to a deployment without the plugin).
 */

import clsx from 'clsx'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { GitStateSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconGitBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './GitBranchLabel.module.css'

/** Registration-side business face for the header chip. */
export interface GitBranchLabelInjected {
  hooks: {
    /** Path-keyed branch states bound by the renderer as useGitStates. */
    gitStates: SnapshotStore<GitStateSnapshot>
  }
}

/** Full component props. */
export type GitBranchLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'ui.gitBranch'>
  & InjectFace<GitBranchLabelInjected>

/**
 * Render this session's working-directory branch beside its title.
 * @param props - composed slot props.
 * @returns the chip, or null for every no-branch state — including before
 *   first resolution — without reserving width.
 */
export function GitBranchLabel({
  sessionId, useSessions, useGitStates, t,
}: GitBranchLabelProps) {
  // The session's own cwd keys its state: concurrent sessions in separate
  // repositories each read their own entry, and a session without a working
  // directory shows nothing.
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const entry = useGitStates(state => (cwd === undefined ? undefined : state.entries[cwd]))

  if (entry === undefined || entry.type === 'no-repository' || entry.type === 'unavailable') return null

  const detached = entry.type === 'detached'
  const text = detached ? entry.commit : entry.branch
  return (
    <span
      className={clsx(css.label, detached && css.detached)}
      title={detached ? `${t('detachedHead')} · ${entry.commit}` : t('hint')}
      aria-label={detached ? `${t('detachedHead')} ${entry.commit}` : `${t('hint')}: ${text}`}
    >
      <IconGitBranchOutline16 size={14} className={css.icon} />
      {/* The branch glyph marks version-control context even when a branch is literally named like the build badge's commit. */}
      <span className={css.name}>{text}</span>
      {detached ? <span className={css.detachedMark}>{t('detachedHead')}</span> : null}
    </span>
  )
}

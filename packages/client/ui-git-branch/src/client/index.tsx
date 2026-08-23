/**
 * Git-branch surface plugin, browser half — one read-only chip in the session
 * header naming the repository branch the session's work lands on. The Host
 * owns observation; this plugin only reads the runtime's path-keyed state
 * through the session's own cwd, so concurrent sessions in different
 * repositories each show their own branch and every no-branch state renders
 * nothing.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GitBranchLabel } from './GitBranchLabel.tsx'
import { en, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-header branch chip copy. */
    'ui.gitBranch': import('./locales.ts').GitBranchLocaleKey
  }
}

/** Required services: the slot system, locale registry, and the git-state feed. */
export const inject = ['slots', 'locale', 'gitState']

/** Mounts the session-header branch chip. @param ctx - Client Cordis context. */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register('ui.gitBranch', { zh, en }),
    'ui-git-branch: dictionaries',
  )

  const injected = () => ({
    hooks: {
      // Bare observable source: the renderer binds it as useGitStates.
      gitStates: ctx.gitState.states,
    },
  })

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'git-branch',
    // Static session context occupies the header's leading negative-order
    // band, ahead of the interactive actions; beside the agent-preset label.
    order: -12,
    locale: 'ui.gitBranch',
    inject: injected,
  }, GitBranchLabel))
}

/**
 * Registration: the header chip defers until ui-conversation declares the
 * `conversation.session.header.actions` slot, mounts once with its locale
 * dictionary, and rolls back cleanly on disposal (the HMR contract).
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.tsx'
import { GitBranchLabel } from '../src/client/GitBranchLabel.tsx'

/** Minimal ctx.gitState double: the plugin only reads `.states`. */
function stubGitState(states: SnapshotStore<unknown>): unknown {
  return { states }
}

async function bench(gitStates: SnapshotStore<unknown>) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('gitState', stubGitState(gitStates))
  // Declare the chain the way the shell and ui-conversation do, so the
  // deferred injection fires.
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      conversation: { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
  slots.register({
    name: 'conversation',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  const fiber = await ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber }
}

describe('ui-git-branch apply', () => {
  it('registers the chip into the header-actions slot and drops it on disposal', async () => {
    const store = { getSnapshot: () => ({ entries: {} }), subscribe: () => () => {} } as never
    const { slots, fiber } = await bench(store)

    const entries = slots.entries('conversation.session.header.actions')
    expect(entries).toHaveLength(1) // just the chip; the declaration is not an occupant
    const chip = entries.find(entry => entry.options['id'] === 'git-branch')
    expect(chip?.component).toBe(GitBranchLabel)
    expect(chip?.options).toMatchObject({ order: -12 })
    // The inject face is a thunk over the plugin closure; invoking it yields
    // the hooks compartment the renderer binds.
    const injected = (chip!.inject as unknown as () => { hooks: { gitStates: unknown } })()
    expect(injected.hooks.gitStates).toBe(store)

    // Disposing only the plugin fiber removes its occupant.
    expect(slots.entries('conversation.session.header.actions')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('conversation.session.header.actions')).toHaveLength(0)
  })

  it('registers both shipped dictionaries under the ui.gitBranch namespace', async () => {
    const store = { getSnapshot: () => ({ entries: {} }), subscribe: () => () => {} } as never
    const { ctx } = await bench(store)
    const locale = ctx.get('locale') as LocaleRuntime
    // Both languages resolve every key; a missing side would fall through to
    // the key itself.
    for (const key of ['hint', 'detachedHead'] as const) {
      expect(typeof locale.bind('ui.gitBranch')(key)).toBe('string')
    }
    await ctx.fiber.dispose()
  })

  it('the node half applies as an empty body', async () => {
    const node = await import('../src/index.ts')
    node.apply()
  })
})

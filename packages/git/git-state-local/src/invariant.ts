/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-git-state-local`.
 * @module @deepseek-ai/dsh-git-state-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-git-state-local'

/** Cordis companion plugin name. */
export const name = 'git-state-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the read-only guarantee this provider makes to target
 * repositories is proven by byte-comparison tests over a full observation
 * lifecycle, not by a runtime probe, and its watcher/timer lifecycle has no
 * cross-event relation beyond the seam contract enforced at `ctx.gitState`.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

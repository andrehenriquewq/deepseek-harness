/**
 * gitState domain zod schemas (names derived from map keys). The state union
 * is a discriminatedUnion('type') mirroring api/git-state.ts; the frame schema
 * for `host/git-state-changed` lives in events.schema.ts and reuses the value
 * schema here.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { GitRepositoryState } from './git-state.ts'

/** One determinate Git repository state (the four-tag closed union). */
export const gitRepositoryStateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('named-branch'), branch: z.string().min(1) }),
  z.object({ type: z.literal('detached'), commit: z.string().min(1) }),
  z.object({ type: z.literal('no-repository') }),
  z.object({ type: z.literal('unavailable'), reason: z.string() }),
]) satisfies z.ZodType<Wire<GitRepositoryState>>

/** gitState.resolve request payload: an absolute directory path. */
export const gitStateResolveRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'gitState.resolve'>>>

/** gitState.resolve response value. */
export const gitStateResolveValueSchema = z.object({
  state: gitRepositoryStateSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'gitState.resolve'>>>

/**
 * Structural equality of two resolved states: same tag and same payload.
 * Shared by the host projection and the client mirror so "changed" means the
 * same thing on both sides of the wire.
 * @param a - previously installed state.
 * @param b - incoming state.
 * @returns whether `b` reports the same fact as `a`.
 */
export function gitRepositoryStatesEqual(a: GitRepositoryState, b: GitRepositoryState): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'named-branch': return (b as typeof a).branch === a.branch
    case 'detached': return (b as typeof a).commit === a.commit
    case 'no-repository': return true
    case 'unavailable': return (b as typeof a).reason === a.reason
    default: return false
  }
}

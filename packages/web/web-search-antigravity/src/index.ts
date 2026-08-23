/**
 * `@deepseek-ai/dsh-web-search-antigravity`: registers an Antigravity-proxy-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key —
 * it registers INTO the seam's provider registry, exactly as its Exa,
 * Perplexity, and DeepSeek siblings do. The key is owned by
 * `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-antigravity
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  AntigravitySearchProvider,
  ANTIGRAVITY_DEFAULT_BASE_URL,
  ANTIGRAVITY_DEFAULT_MAX_TOKENS,
  ANTIGRAVITY_DEFAULT_MODEL,
} from './provider.ts'

export {
  ANTIGRAVITY_DEFAULT_BASE_URL,
  ANTIGRAVITY_DEFAULT_MAX_TOKENS,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_SEARCH_INSTRUCTION,
  AntigravitySearchProvider,
} from './provider.ts'
export type { AntigravitySearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-antigravity'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /**
   * Bearer token for proxies that require one. Falls back to
   * `$ANTIGRAVITY_API_KEY`; empty sends no `authorization` header and stays
   * usable (local proxies commonly run without authentication).
   */
  apiKey?: string
  /** Endpoint base; `/chat/completions` is appended. Defaults to the common local proxy address. */
  baseURL?: string
  /** Model name sent as the chat `model` field. Defaults to `gemini-3-flash`. */
  model?: string
  /** Upper bound on generated answer tokens. Defaults to `1024`. Must be a positive integer. */
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1),
})

/** Register the Antigravity search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new AntigravitySearchProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('ANTIGRAVITY_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? ANTIGRAVITY_DEFAULT_BASE_URL,
    model: config.model ?? ANTIGRAVITY_DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? ANTIGRAVITY_DEFAULT_MAX_TOKENS,
  }))
}

import { describe, expect, it } from 'vitest'
import {
  AntigravitySearchProvider,
  ANTIGRAVITY_DEFAULT_MAX_TOKENS,
  ANTIGRAVITY_DEFAULT_MODEL,
} from '@deepseek-ai/dsh-web-search-antigravity'

/**
 * Real-proxy smoke for the Antigravity search provider. Self-skips unless
 * `$ANTIGRAVITY_BASE_URL` points at a running local proxy (CI has neither the
 * proxy nor Google credentials), per the with-credentials e2e policy in
 * docs/testing.md.
 */
const baseURL = process.env.ANTIGRAVITY_BASE_URL
const maybe = baseURL !== undefined && baseURL.length > 0 ? describe : describe.skip

maybe('AntigravitySearchProvider real proxy', () => {
  it('returns a grounded answer from a live query', async () => {
    const provider = new AntigravitySearchProvider({
      apiKey: process.env.ANTIGRAVITY_API_KEY ?? '',
      baseURL: baseURL!,
      model: ANTIGRAVITY_DEFAULT_MODEL,
      maxTokens: ANTIGRAVITY_DEFAULT_MAX_TOKENS,
    })
    const result = await provider.search({ query: 'current DeepSeek Harness release' })
    expect(result.content).toBeTruthy()
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 60_000)
})

/**
 * `AntigravitySearchProvider`: a `WebSearchProvider` backed by a local
 * Antigravity proxy's OpenAI-compatible chat-completions endpoint. Each search
 * is one auxiliary model call over a Gemini backend whose Google Search
 * grounding performs server-side retrieval; the generated answer becomes
 * `content` and forwarded grounding chunks become `sources`. The wire format
 * and native `fetch` client are provider-private and do not use `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search-antigravity/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type {
  AntigravityChatResponse,
  AntigravityError,
  AntigravityGroundingChunk,
} from './types.ts'

/** Stable id this provider registers under. */
export const ANTIGRAVITY_PROVIDER_ID = 'antigravity'

/**
 * Default proxy endpoint base; `/chat/completions` is appended. Matches the
 * documented default (`http://localhost:8080/v1`) of the common local
 * Antigravity proxies; deployments override it per composition.
 */
export const ANTIGRAVITY_DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1'

/** Default search model (a Gemini model with Search grounding available). */
export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3-flash'

/** Default upper bound on generated answer tokens. */
export const ANTIGRAVITY_DEFAULT_MAX_TOKENS = 1024

/**
 * Fixed system instruction sent with every search. It asks the backing Gemini
 * to ground the answer in current web results; whether grounding runs is still
 * decided by the proxy and its account quotas.
 */
export const ANTIGRAVITY_SEARCH_INSTRUCTION =
  'Answer the query using Google Search grounding over current web results. Reply with a concise answer followed by the URLs of the sources you used.'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface AntigravitySearchProviderOptions {
  /**
   * Optional bearer token for proxies that require one. Unlike the hosted
   * search providers, an empty key does NOT make the provider unavailable:
   * local Antigravity proxies commonly run without authentication.
   */
  apiKey: string
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Model name sent as the chat `model` field. */
  model: string
  /** Upper bound on generated answer tokens (`max_tokens`). */
  maxTokens: number
}

/**
 * Map one forwarded grounding chunk to a normalized source, or `undefined`
 * when it carries no URL (a chunk without a `web.uri` has nothing portable
 * to cite).
 *
 * @param chunk - one entry of the forwarded `groundingChunks[]`.
 * @returns the normalized source, or `undefined` when the chunk has no URI.
 */
export function mapAntigravityChunk(chunk: AntigravityGroundingChunk): WebSearchSource | undefined {
  const url = chunk.web?.uri
  if (url == null || url.length === 0) return undefined
  const title = chunk.web?.title
  return {
    url,
    ...title != null && title.length > 0 ? { title } : {},
  }
}

/**
 * Map a chat-completions response envelope to a normalized search result.
 * The generated answer becomes `content`; forwarded grounding chunks become
 * sources. A response without grounding metadata yields no sources — the
 * provider never extracts citation links out of the answer prose.
 *
 * @param response - the parsed chat-completions response body.
 * @returns the normalized result; `content` is omitted when the answer is empty.
 */
export function mapAntigravityResponse(response: AntigravityChatResponse): WebSearchResult {
  const content = response.choices?.[0]?.message?.content
  const sources = (response.groundingMetadata?.groundingChunks ?? [])
    .map(mapAntigravityChunk)
    .filter((source): source is WebSearchSource => source !== undefined)
  return {
    ...content != null && content.length > 0 ? { content } : {},
    sources,
    truncated: false,
  }
}

/** The Antigravity-proxy-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class AntigravitySearchProvider implements WebSearchProvider {
  readonly id = ANTIGRAVITY_PROVIDER_ID

  constructor(private readonly options: AntigravitySearchProviderOptions) {}

  // Availability stays beside this provider's distinct config contract: unlike
  // its siblings, an empty apiKey is usable because local proxies commonly run
  // unauthenticated, so only shape-valid fields gate availability here.
  /* jscpd:ignore-start */
  available(): boolean {
    return URL.canParse(this.options.baseURL)
      && this.options.model.length > 0
      && isPositiveInteger(this.options.maxTokens)
  }
  /* jscpd:ignore-end */

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
          ...this.options.apiKey.length > 0 ? { 'authorization': `Bearer ${this.options.apiKey}` } : {},
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: this.options.maxTokens,
          messages: [
            { role: 'system', content: ANTIGRAVITY_SEARCH_INSTRUCTION },
            { role: 'user', content: request.query },
          ],
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Antigravity search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Antigravity search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Antigravity proxy error (HTTP ${status})`
      try {
        const parsed = await response.json() as AntigravityError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Antigravity search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as AntigravityChatResponse
      return mapAntigravityResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Antigravity search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Antigravity proxy returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

// These two predicates are intentionally local: exporting generic internals
// from the public web seam would add more API than these pure checks.
/* jscpd:ignore-start */
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for a request limit that can be sent to the proxy (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
/* jscpd:ignore-end */

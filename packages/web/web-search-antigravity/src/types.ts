/**
 * Wire types for the Antigravity proxy's OpenAI-compatible chat-completions
 * endpoint (`POST {baseURL}/chat/completions`). The backing Gemini models reach
 * the web through Google Search grounding; a proxy may forward that grounding
 * metadata on the response envelope, and this package maps it when present.
 * Types only — no runtime code. The provider-private wire shape does not depend
 * on `ctx.llm`.
 *
 * @module @deepseek-ai/dsh-web-search-antigravity/types
 */

/** Request body sent to the chat-completions endpoint. */
export interface AntigravityChatRequest {
  model: string
  max_tokens: number
  messages: readonly [
    { readonly role: 'system'; readonly content: string },
    { readonly role: 'user'; readonly content: string },
  ]
}

/** One Search-grounding source forwarded from the Gemini response. */
export interface AntigravityGroundingChunk {
  web?: {
    uri?: string | null
    title?: string | null
  }
}

/** Gemini Search-grounding metadata a proxy forwards on the response envelope. */
export interface AntigravityGroundingMetadata {
  groundingChunks?: AntigravityGroundingChunk[]
}

/** Response envelope, plus optional forwarded grounding data. */
export interface AntigravityChatResponse {
  choices?: {
    message?: {
      content?: string | null
    }
  }[]
  /** Forwarded Google Search grounding metadata (proxy-dependent). */
  groundingMetadata?: AntigravityGroundingMetadata
}

/** Error response envelope (best-effort; fields vary by failure). */
export interface AntigravityError {
  error?: { message?: string } | string
  message?: string
}

# Agent Note: Antigravity-proxy search provider

Status: implemented

English | [中文](2026-08-23-antigravity-proxy-search-provider.zh.md)

## Problem

DeepSeek Harness ships exactly one search route (`web-search-deepseek`), which bills every search against the configured DeepSeek API credential. Operators running a local Antigravity proxy — an OpenAI-compatible relay over Google's Antigravity Cloud Code backend whose Gemini models ground answers with Google Search — want that grounding to serve `web_search`, without touching the DeepSeek API at all.

## Decision

`packages/web/web-search-antigravity/` is the fourth search provider on the `ctx.web` seam, following the same Service Provider shape as its Exa and Perplexity siblings: one auxiliary model call per search over `POST {baseURL}/chat/completions`, the generated answer mapped to `content`, and forwarded Google Search grounding chunks (`groundingMetadata.groundingChunks[].web`) mapped to `sources`. It deviates from its siblings in two deliberate ways:

- **An empty `apiKey` stays available.** Exa and Perplexity gate `available()` on credential presence because their APIs require keys; local Antigravity proxies commonly run unauthenticated, so availability there gates only on config shape.
- **Sources come only from structured grounding metadata; absence yields an empty-sources success.** The OpenAI-compatible chat shape has no portable way to demand the server-side Search tool and proxies differ in whether they forward `groundingMetadata`, so the honest contract is best-effort mapping rather than an error — but citation links are never scraped out of the answer prose.

The provider is not mounted in the shipped base composition; the DeepSeek route remains the default and the Antigravity route is documented for personal composition overlays, because proxying searches through Antigravity consumes Google account quota outside its intended client and may violate its terms of service.

## Alternatives considered

- **Reusing an existing provider pointed at the proxy** — each sibling's wire format is fixed to one vendor's API; none speaks OpenAI-compatible chat plus Gemini grounding metadata.
- **One generic "grounded chat" provider parameterized per vendor** — speculative abstraction with one concrete consumer; rejected under the current-owner rule.
- **Falling back to extracting markdown links from the answer text** — would make the seam invent sources the provider never returned; rejected under the deepseek precedent of erroring or returning empty rather than scraping.

## Consequences

Search can run entirely on a local proxy with no DeepSeek API involvement, at the cost of one auxiliary model call per query on Google account quota. The zero-sources outcome is indistinguishable from a genuinely source-less answer, which is acceptable for search (the model still receives the grounded answer text) but means operators cannot distinguish "proxy strips metadata" from "no results" without inspecting proxy logs. If a future proxy demands an explicit tool field to force grounding, adding it honestly belongs behind a provider-neutral seam field, not this package's config.

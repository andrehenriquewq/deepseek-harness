# @deepseek-ai/dsh-web-search-antigravity

English | [中文](README.zh.md)

An [Antigravity](https://github.com/google/antigravity)-proxy-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls a local proxy's OpenAI-compatible `POST /chat/completions` endpoint; each search is one auxiliary model call over a Gemini backend whose Google Search grounding performs server-side retrieval.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like its Exa and Perplexity siblings, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$ANTIGRAVITY_API_KEY` | Bearer token for proxies that require one. Empty sends no `authorization` header and stays usable — local proxies commonly run unauthenticated. |
| `baseURL` | `http://127.0.0.1:8080/v1` | Proxy endpoint base; `/chat/completions` is appended. An unparseable value makes the provider unavailable. |
| `model` | `gemini-3-flash` | Model name sent as the chat `model` field; must be a Gemini model with Search grounding available through the proxy. |
| `maxTokens` | `1024` | Upper bound on generated answer tokens (`max_tokens`). Must be a positive integer. |

```yaml
- id: web-search-antigravity
  name: '@deepseek-ai/dsh-web-search-antigravity'
  config:
    baseURL: 'http://127.0.0.1:8080/v1'
```

Point the seam at this provider by setting `searchProvider: antigravity` on the `@deepseek-ai/dsh-web` row of your composition overlay.

## Mapping

The generated answer becomes `content`. Sources come only from forwarded Google Search grounding metadata: a response-envelope `groundingMetadata.groundingChunks[]` maps each chunk's `web.uri` to `url` and `web.title` to `title`; chunks without a URI are dropped. A grounded answer without forwarded metadata yields a valid empty-sources result — citation links are never extracted out of the answer prose. The fixed system instruction asks for grounding but whether it runs stays with the proxy and its account quotas. Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's generated answer and grounding-chunk URLs and titles or its exact `Antigravity search aborted`, `Antigravity search request failed: <error>`, and `Antigravity proxy returned an unprocessable response body: <error>` failures under the consumer's error wrapper while provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Grounding metadata forwarding is proxy-dependent** — proxies that drop the envelope's `groundingMetadata` still answer well but return zero sources, because scraping citation links from the answer prose would make the seam lie.
- **Grounding activation cannot be forced from here** — the OpenAI-compatible chat shape has no portable way to demand the server-side Search tool; if a proxy needs an explicit tool field, that is a Service Definition change deferred to a provider-neutral seam field.
- **Unofficial upstream access** — routing searches through an Antigravity proxy uses Google account quota outside its intended client and may violate its terms of service; keep this route on personal compositions.

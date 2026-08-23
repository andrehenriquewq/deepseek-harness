import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { AntigravitySearchProvider, ANTIGRAVITY_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-antigravity'
import * as antigravityPlugin from '@deepseek-ai/dsh-web-search-antigravity'
import { ANTIGRAVITY_SEARCH_INSTRUCTION, mapAntigravityChunk, mapAntigravityResponse } from '../src/provider.ts'

const options = { apiKey: 'proxy-key', baseURL: 'http://127.0.0.1:8080/v1', model: 'gemini-3-flash', maxTokens: 1024 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function chatResponse(content: string, groundingChunks?: unknown[]): Record<string, unknown> {
  return {
    choices: [{ message: { content } }],
    ...(groundingChunks !== undefined ? { groundingMetadata: { groundingChunks } } : {}),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Antigravity result mapping', () => {
  it('maps a full grounding chunk', () => {
    expect(mapAntigravityChunk({ web: { uri: 'https://a.test', title: 'A' } }))
      .toEqual({ url: 'https://a.test', title: 'A' })
  })

  it('drops a chunk without a usable URI', () => {
    expect(mapAntigravityChunk({})).toBeUndefined()
    expect(mapAntigravityChunk({ web: {} })).toBeUndefined()
    expect(mapAntigravityChunk({ web: { uri: null } })).toBeUndefined()
    expect(mapAntigravityChunk({ web: { uri: '' } })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapAntigravityChunk({ web: { uri: 'https://a.test', title: null } }))
      .toEqual({ url: 'https://a.test' })
    expect(mapAntigravityChunk({ web: { uri: 'https://a.test', title: '' } }))
      .toEqual({ url: 'https://a.test' })
  })

  it('maps a response to a result with content and mapped sources', () => {
    expect(mapAntigravityResponse({
      choices: [{ message: { content: 'grounded answer' } }],
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://a.test' } }, { web: {} }] },
    })).toEqual({
      content: 'grounded answer',
      sources: [{ url: 'https://a.test' }],
      truncated: false,
    })
  })

  it('keeps an answer without grounding metadata as a valid empty-sources result', () => {
    const result = mapAntigravityResponse(chatResponse('answer only'))
    expect(result).toEqual({ content: 'answer only', sources: [], truncated: false })
  })

  it('tolerates a missing choices array', () => {
    expect(mapAntigravityResponse({}).sources).toEqual([])
    expect(mapAntigravityResponse({}).content).toBeUndefined()
  })
})

describe('AntigravitySearchProvider availability', () => {
  it('is available with every field shaped correctly', () => {
    expect(new AntigravitySearchProvider(options).available()).toBe(true)
  })

  it('stays available WITHOUT a key (local proxies commonly run unauthenticated)', () => {
    expect(new AntigravitySearchProvider({ ...options, apiKey: '' }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new AntigravitySearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when the model is empty', () => {
    expect(new AntigravitySearchProvider({ ...options, model: '' }).available()).toBe(false)
  })

  it('is misconfigured when maxTokens is not a positive integer', () => {
    expect(new AntigravitySearchProvider({ ...options, maxTokens: 0 }).available()).toBe(false)
    expect(new AntigravitySearchProvider({ ...options, maxTokens: 1.5 }).available()).toBe(false)
  })
})

describe('AntigravitySearchProvider request mapping', () => {
  it('sends the grounded-chat request to the proxy endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(chatResponse('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await new AntigravitySearchProvider(options).search({ query: 'hello' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer proxy-key')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gemini-3-flash',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: ANTIGRAVITY_SEARCH_INSTRUCTION },
        { role: 'user', content: 'hello' },
      ],
    })
  })

  it('sends no authorization header when no key is configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(chatResponse('ok')))
    vi.stubGlobal('fetch', fetchMock)

    await new AntigravitySearchProvider({ ...options, apiKey: '' }).search({ query: 'q' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(chatResponse('ok')))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new AntigravitySearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('AntigravitySearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the proxy message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'quota exhausted' } }, { status: 429 })))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'quota exhausted' }))
  })

  it('accepts a plain-string error detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 })))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('proxy down', { status: 502 })))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Antigravity proxy error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Antigravity proxy error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to an empty result, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: {} }, { status: 200 })))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new AntigravitySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-antigravity plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(chatResponse('ok'))))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ANTIGRAVITY_PROVIDER_ID })
    const fiber = await ctx.plugin(antigravityPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in antigravityPlugin).toBe(false)
  })

  it('threads model and maxTokens config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(chatResponse('ok')))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ANTIGRAVITY_PROVIDER_ID })
    const fiber = await ctx.plugin(antigravityPlugin, { model: 'gemini-3-pro-high', maxTokens: 2048 })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gemini-3-pro-high', max_tokens: 2048 })
    await fiber.dispose()
  })

  it('falls back to $ANTIGRAVITY_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.ANTIGRAVITY_API_KEY
    process.env.ANTIGRAVITY_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse(chatResponse('ok')))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: ANTIGRAVITY_PROVIDER_ID })
      const fiber = await ctx.plugin(antigravityPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions')
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-key')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.ANTIGRAVITY_API_KEY
      else process.env.ANTIGRAVITY_API_KEY = prev
    }
  })

  it('is unavailable when configured with an unparseable base URL', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ANTIGRAVITY_PROVIDER_ID })
    await ctx.plugin(antigravityPlugin, { baseURL: 'not a url' })
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })
})

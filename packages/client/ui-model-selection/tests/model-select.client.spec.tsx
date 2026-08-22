// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

// Two groups, so a query can drop a whole group; one model carries a
// description and the ids differ from the display names, which is what the
// id/description matching assertions below need.
const filterFixture = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Maior contexto' },
    ],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    models: [
      { id: 'gemini-3-flash', name: 'gemini-3-flash' },
      { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6' },
    ],
  },
]

/** Rendered option labels, in list order; empty when the filter matched nothing. */
const listed = (): string[] =>
  screen.queryAllByRole('menuitemradio').map(item => item.textContent ?? '')

/** Render the seat and drill into the model pane, where the filter lives. */
function openModelPane(select = vi.fn().mockResolvedValue(true)): { search: HTMLElement } {
  render(<ModelSelect
    locked={false}
    available
    directory={createSnapshotStore(state({ groups: filterFixture }))}
    load={vi.fn()}
    select={select}
    t={t}
  />)
  fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
  return { search: screen.getByRole('searchbox') }
}

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect model filter', () => {
  it('keeps every group when the filter is blank and narrows to one when it is not', () => {
    const { search } = openModelPane()
    expect(listed()).toEqual([
      'DeepSeek-V4-Flash', 'DeepSeek-V4-ProMaior contexto', 'gemini-3-flash', 'claude-sonnet-4-6',
    ])
    expect(screen.getByText('Antigravity')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'gemini' } })
    expect(listed()).toEqual(['gemini-3-flash'])
    // The group that lost every model loses its heading, not just its rows.
    expect(screen.queryByText('DeepSeek')).toBeNull()
  })

  it('matches on the group name, the model id, and the description', () => {
    const { search } = openModelPane()

    fireEvent.change(search, { target: { value: 'antigravity' } })
    expect(listed()).toEqual(['gemini-3-flash', 'claude-sonnet-4-6'])

    fireEvent.change(search, { target: { value: 'v4-pro' } })
    expect(listed()).toEqual(['DeepSeek-V4-ProMaior contexto'])

    fireEvent.change(search, { target: { value: 'Maior' } })
    expect(listed()).toEqual(['DeepSeek-V4-ProMaior contexto'])
  })

  it('requires every whitespace-separated token to match the same row', () => {
    const { search } = openModelPane()

    fireEvent.change(search, { target: { value: '  claude   sonnet  ' } })
    expect(listed()).toEqual(['claude-sonnet-4-6'])

    // Two tokens that each match a row, but never the same one.
    fireEvent.change(search, { target: { value: 'claude deepseek' } })
    expect(listed()).toEqual([])
  })

  it('names the query when nothing matches, and distinguishes that from an empty catalog', () => {
    const { search } = openModelPane()
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('没有与“zzz”匹配的模型。')).toBeTruthy()
    expect(screen.queryByText('没有可用的模型。')).toBeNull()

    cleanup()
    const empty = createSnapshotStore(state({ groups: [], current: null }))
    render(<ModelSelect
      locked={false}
      available
      directory={empty}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.getByText('没有可用的模型。')).toBeTruthy()
    expect(screen.queryByText(/匹配的模型/)).toBeNull()
  })

  it('focuses the filter on entry and moves into the list on ArrowDown', () => {
    const { search } = openModelPane()
    expect(document.activeElement).toBe(search)

    // The first row of the list is the first group's heading, which is itself
    // a control now.
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const heading = screen.getByRole('menuitem', { name: /DeepSeek/ })
    expect(document.activeElement).toBe(heading)

    // The generic wrap-around drives movement from there; the box-relative
    // branch applies only while the caret is still in the box.
    fireEvent.keyDown(heading, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitemradio')[0])
  })

  it('discards the query when the pane is left', () => {
    const { search } = openModelPane()
    fireEvent.change(search, { target: { value: 'gemini' } })
    expect(listed()).toEqual(['gemini-3-flash'])

    fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.getByRole('searchbox')).toHaveProperty('value', '')
    expect(listed()).toHaveLength(4)
  })

  it('selects the model the filter narrowed to', async () => {
    const select = vi.fn().mockResolvedValue(true)
    const { search } = openModelPane(select)
    fireEvent.change(search, { target: { value: 'gemini' } })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'gemini-3-flash' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'antigravity', model: 'gemini-3-flash' })
    })
  })
})

describe('ModelSelect group folding', () => {
  const heading = (name: RegExp): HTMLElement => screen.getByRole('menuitem', { name })

  it('folds a group away on its heading and brings it back on a second press', () => {
    openModelPane()
    expect(listed()).toHaveLength(4)

    fireEvent.click(heading(/DeepSeek/))
    expect(listed()).toEqual(['gemini-3-flash', 'claude-sonnet-4-6'])
    // The heading survives folding — it is the way back — and keeps reporting
    // what the fold is hiding.
    expect(heading(/DeepSeek/).getAttribute('aria-expanded')).toBe('false')
    expect(heading(/DeepSeek/).textContent).toContain('2')

    fireEvent.click(heading(/DeepSeek/))
    expect(listed()).toHaveLength(4)
    expect(heading(/DeepSeek/).getAttribute('aria-expanded')).toBe('true')
  })

  it('folds each group independently', () => {
    openModelPane()
    fireEvent.click(heading(/DeepSeek/))
    fireEvent.click(heading(/Antigravity/))
    expect(listed()).toEqual([])

    fireEvent.click(heading(/Antigravity/))
    expect(listed()).toEqual(['gemini-3-flash', 'claude-sonnet-4-6'])
  })

  it('keeps a fold across pane visits, unlike the query', () => {
    const { search } = openModelPane()
    fireEvent.click(heading(/DeepSeek/))
    fireEvent.change(search, { target: { value: 'claude' } })

    fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))

    expect(screen.getByRole('searchbox')).toHaveProperty('value', '')
    expect(heading(/DeepSeek/).getAttribute('aria-expanded')).toBe('false')
    expect(listed()).toEqual(['gemini-3-flash', 'claude-sonnet-4-6'])
  })

  it('shows a folded group\'s matches while a query is active', () => {
    const { search } = openModelPane()
    fireEvent.click(heading(/DeepSeek/))
    expect(listed()).toEqual(['gemini-3-flash', 'claude-sonnet-4-6'])

    // The fold is not cleared, only overridden: a search that hid its own
    // answer would be worse than no search.
    fireEvent.change(search, { target: { value: 'v4-pro' } })
    expect(listed()).toEqual(['DeepSeek-V4-ProMaior contexto'])

    fireEvent.change(search, { target: { value: '' } })
    expect(listed()).toEqual(['gemini-3-flash', 'claude-sonnet-4-6'])
  })

  it('counts the matches rather than the catalog while a query is active', () => {
    const { search } = openModelPane()
    expect(heading(/DeepSeek/).textContent).toContain('2')

    fireEvent.change(search, { target: { value: 'v4-pro' } })
    expect(heading(/DeepSeek/).textContent).toContain('1')
  })
})

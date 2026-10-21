/**
 * WP413：侧边栏组件（jsdom + 假的后台：`send` 是替身，不碰 `chrome.*`、不联网）。
 *
 * 看进度 → 改草稿 → 填进页面（带改过的字与卡的版本）→ 工坊那边读回确认 → 这一条变「已发 · 已记录」；
 * 记录里标「在插件里批的」、各去处写没写进去；没配对就地配；这个 Chrome 没连 Reddit 就地连；只能看的令牌按钮点不了。
 */
import type { PanelSnapshot } from '@agentsws/browser-action'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtensionMessage, ExtensionResponse } from '../src/lib/messages'
import type { PanelState } from '../src/lib/panel/broker'
import { SidePanel } from '../src/ui/side-panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const card = {
  id: 'ap_1',
  version: 2,
  kind: 'reply' as const,
  subreddit: 'ivraxr',
  title: '回复 alice（Reddit · r/ivraxr）',
  post_title: 'Does the Air3 work with glasses?',
  parent_author: 'alice',
  parent_text: 'Mine fogs up a bit when I wear glasses.',
  link: 'https://www.reddit.com/r/ivraxr/comments/abc/s/c1/',
  draft: { text: 'It fits over most frames.' },
  reason: '用户在问兼容性',
  facts: [{ id: 'fc_1', text: 'Q: glasses? A: yes' }],
  created_at: '2026-10-18T01:00:00.000Z',
}

const base = (over: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  at: '2026-10-18T02:00:00.000Z',
  workspace_name: 'IVRA',
  person_name: 'Luoye',
  can_act: true,
  progress: {
    configured: true,
    account: 'ivra_official',
    reddit_connected: true,
    reading: false,
    drafting: 1,
    pending: 2,
    next_run_at: '2026-10-19T01:00:00.000Z',
    last_run: {
      started_at: '2026-10-18T01:49:00.000Z',
      finished_at: '2026-10-18T01:52:00.000Z',
      trigger: 'schedule',
      pending: 2,
      parts: [
        { part: 'inbox', status: 'ok', fetched: 7, fresh: 2 },
        { part: 'own_sub', status: 'ok', fetched: 26, fresh: 0 },
        {
          part: 'external',
          status: 'failed',
          fetched: 0,
          fresh: 0,
          message: '被 Reddit 拦了，已停',
        },
      ],
    },
  },
  cards: [card],
  writes: [],
  records: [],
  sinks: [],
  ...over,
})

let host: HTMLDivElement
let root: Root
const sent: ExtensionMessage[] = []
let state: PanelState
let actReply: ExtensionResponse = { type: 'panel-act', ok: true }

const send = async (m: ExtensionMessage): Promise<ExtensionResponse | undefined> => {
  sent.push(m)
  if (m.type === 'panel-state') return { type: 'panel-state', state }
  if (m.type === 'pair') return { type: 'pair', ok: true, message: '配好了。', status: {} as never }
  if (m.type.startsWith('panel-')) return actReply
  return { type: 'ack' }
}

async function mount(extra: Partial<Parameters<typeof SidePanel>[0]> = {}): Promise<void> {
  await act(async () => {
    root.render(<SidePanel send={send} refreshMs={60_000} {...extra} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)
const click = async (el: Element | null) => {
  if (el === null) throw new Error('没找到')
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise((r) => setTimeout(r, 0))
  })
}
const type = async (el: Element | null, value: string) => {
  if (el === null) throw new Error('没找到')
  await act(async () => {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  sent.length = 0
  actReply = { type: 'panel-act', ok: true }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('WP413 侧边栏', () => {
  it('有卡默认停在「要你处理」：卡在「等你发」里（WP445）原帖、理由、草稿都在；改草稿 → 打开这一条（= 批）带改过的字与版本 → 读回后「已发 · 已记录」', async () => {
    state = { kind: 'ok', snapshot: base(), reddit_here: true }
    await mount()
    expect(q('ws-who')?.textContent).toBe('IVRA · Luoye')
    expect(q('ws-tab-todo')?.getAttribute('aria-selected')).toBe('true')
    expect(q('ws-desk-quote')?.textContent).toContain('fogs up')
    expect(q('ws-desk-reason')?.textContent).toContain('兼容性')
    const draft = q('ws-desk-draft') as HTMLTextAreaElement
    expect(draft.value).toBe('It fits over most frames.')
    await type(draft, 'Edited in the side panel.')
    state = {
      kind: 'ok',
      snapshot: base({
        cards: [],
        writes: [
          {
            job_id: 'aj_1',
            approval_item_id: 'ap_1',
            state: 'sent',
            subreddit: 'ivraxr',
            label: card.title,
            record_id: 'ob_1',
            link: 'https://www.reddit.com/r/ivraxr/comments/abc/s/new1/',
            queued_at: '2026-10-18T02:00:00.000Z',
            via_extension: true,
          },
        ],
      }),
      reddit_here: true,
    }
    await click(q('ws-desk-open'))
    expect(sent.find((m) => m.type === 'panel-fill')).toEqual({
      type: 'panel-fill',
      id: 'ap_1',
      version: 2,
      text: 'Edited in the side panel.',
    })
    expect(q('ws-write')?.textContent).toContain('已发 · 已记录')
    expect(q('ws-todo-empty')).not.toBeNull()
  })

  it('没改就不带 text；「不发」带版本；本机回的原话照印', async () => {
    state = { kind: 'ok', snapshot: base(), reddit_here: true }
    await mount()
    actReply = { type: 'panel-act', ok: false, message: '这张卡已经处理过了（在工坊里或另一处）。' }
    await click(q('ws-desk-open'))
    expect(sent.find((m) => m.type === 'panel-fill')).toEqual({
      type: 'panel-fill',
      id: 'ap_1',
      version: 2,
    })
    expect(host.textContent).toContain('已经处理过了')
    // WP445：「不发」理由可选——不写理由也一下就不发
    await click(q('ws-desk-skip'))
    await click(q('ws-desk-skip-now'))
    expect(sent.find((m) => m.type === 'panel-skip')).toEqual({
      type: 'panel-skip',
      id: 'ap_1',
      version: 2,
    })
  })

  it('进度：几点读完、下次几点、每块条数、失败照实说、起草中 / 待回', async () => {
    state = { kind: 'ok', snapshot: base({ cards: [] }), reddit_here: true }
    await mount()
    expect(q('ws-tab-progress')?.getAttribute('aria-selected')).toBe('true')
    expect(q('ws-progress-head')?.textContent).toMatch(/读完$/u)
    const parts = q('ws-parts')?.textContent ?? ''
    expect(parts).toContain('收件箱7 条 · 新 2')
    expect(parts).toContain('自家版块26 条')
    expect(parts).toContain('被 Reddit 拦了，已停')
    expect(q('ws-now')?.textContent).toContain('起草中 1')
    expect(host.textContent).toContain('u/ivra_official')
  })

  it('记录：在插件里批的、各去处写没写进去', async () => {
    state = {
      kind: 'ok',
      snapshot: base({
        cards: [],
        records: [
          {
            id: 'ob_1',
            sent_at: '2026-10-18T02:01:00.000Z',
            channel: 'reddit',
            action: 'reply',
            destination: 'r/ivraxr',
            content: 'Edited in the side panel.',
            status: 'sent',
            via_extension: true,
            sinks: [
              { name: 'IVRA 回复记录', status: 'written' },
              { name: '备份表', status: 'failed', message: '飞书授权过期了' },
            ],
          },
        ],
        sinks: [{ name: 'IVRA 回复记录', state: 'active', written: 1, pending: 0 }],
      }),
      reddit_here: true,
    }
    await mount()
    await click(q('ws-tab-records'))
    expect(q('ws-via-ext')?.textContent).toBe('在插件里批的')
    expect(q('ws-sinkres')?.textContent).toContain('IVRA 回复记录')
    expect(q('ws-sinks')?.textContent).toContain('已写 1')
  })

  it('没配对就地配；这个 Chrome 没连 Reddit 就地连；只能看的令牌按钮点不了', async () => {
    state = { kind: 'unpaired' }
    await mount()
    expect(q('ws-pair')).not.toBeNull()
    await type(host.querySelector('input[aria-label="配对码"]'), '123456')
    await click(host.querySelector('[data-testid="ws-pair"] button'))
    expect(sent.find((m) => m.type === 'pair')).toEqual({ type: 'pair', code: '123456' })

    act(() => root.unmount())
    root = createRoot(host)
    state = { kind: 'ok', snapshot: base({ can_act: false }), reddit_here: false }
    let asked = 0
    await mount({
      connectReddit: async () => {
        asked += 1
        return true
      },
    })
    expect((q('ws-desk-open') as HTMLButtonElement).disabled).toBe(true)
    await click(q('ws-connect-reddit')?.querySelector('button') ?? null)
    expect(asked).toBe(1)
    expect(sent.map((m) => m.type)).toEqual(expect.arrayContaining(['reddit-poll', 'ads-poll']))
  })
})

describe('WP457 侧边栏头部', () => {
  it('只有品牌名就只写品牌名；品牌名和人名都没有就整行不画（不写内部 id）', async () => {
    const { workspace_name: _w, person_name: _p, ...rest } = base()
    state = { kind: 'ok', snapshot: { ...rest, workspace_name: 'IVRA' }, reddit_here: true }
    await mount()
    expect(q('ws-who')?.textContent).toBe('IVRA')
    act(() => root.unmount())
    root = createRoot(host)
    state = { kind: 'ok', snapshot: rest, reddit_here: true }
    await mount()
    expect(q('ws-who')).toBeNull()
  })
})

/**
 * WP419（自查 R5 / U17 / U15）：侧边栏照实说起草卡在哪一步——「等你定口吻」那一行在「要你处理」顶上、带「去定」
 * （在工坊里打开那张卡；只拼本机地址）；卡上带 WP411 的几道检查与「品牌号在这串里说过」。
 * jsdom + 替身后台，不碰 `chrome.*`、不联网。
 */
import type { PanelSnapshot } from '@agentsws/browser-action'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtensionMessage, ExtensionResponse } from '../src/lib/messages'
import type { PanelState } from '../src/lib/panel/broker'
import { composeUrlAllowed, workshopCardUrl } from '../src/lib/panel/format'
import { SidePanel } from '../src/ui/side-panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const snap = (over: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  at: '2026-10-18T02:00:00.000Z',
  workspace_name: 'IVRA',
  can_act: true,
  progress: {
    configured: true,
    reading: false,
    drafting: 0,
    pending: 1,
    replied_before: 2,
    stage: {
      kind: 'needs_persona',
      count: 1,
      text: '1 条等你先定品牌号怎么说话',
      card_id: 'ap_persona',
    },
  },
  cards: [],
  writes: [],
  records: [],
  sinks: [],
  ...over,
})

let host: HTMLDivElement
let root: Root
const sent: ExtensionMessage[] = []
let state: PanelState
const send = async (m: ExtensionMessage): Promise<ExtensionResponse | undefined> => {
  sent.push(m)
  if (m.type === 'panel-state') return { type: 'panel-state', state }
  return { type: 'ack' }
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)
async function mount(): Promise<void> {
  await act(async () => {
    root.render(<SidePanel send={send} refreshMs={60_000} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
const click = async (el: Element | null) => {
  if (el === null) throw new Error('没找到')
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  sent.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('WP419 侧边栏：卡在哪一步照实说', () => {
  it('等你定口吻：「要你处理」顶上一行 + 去定（开工坊里那张卡），角标算它一件；进度里也有、带「已回过」', async () => {
    state = { kind: 'ok', snapshot: snap(), reddit_here: true }
    await mount()
    expect(q('ws-stage')?.textContent).toContain('等你先定品牌号怎么说话')
    expect(q('ws-stage')?.getAttribute('data-kind')).toBe('needs_persona')
    expect(q('ws-tab-todo')?.textContent).toContain('1')
    await click(q('ws-stage-open'))
    expect(sent).toContainEqual({ type: 'open-workshop-card', id: 'ap_persona' })
    await click(q('ws-tab-progress'))
    expect(q('ws-stage')?.textContent).toContain('品牌号怎么说话')
    expect(q('ws-replied-before')?.textContent).toContain('2')
  })

  it('等读整串只在进度里说（不是要你动手的事），「要你处理」里不出那一行', async () => {
    state = {
      kind: 'ok',
      snapshot: snap({
        progress: {
          configured: true,
          reading: false,
          drafting: 0,
          pending: 1,
          stage: {
            kind: 'reading_thread',
            count: 1,
            text: '先在你的浏览器里读整串（1 条），读完就起草',
          },
        },
      }),
      reddit_here: true,
    }
    await mount()
    await click(q('ws-tab-todo'))
    expect(q('ws-stage')).toBeNull()
    await click(q('ws-tab-progress'))
    expect(q('ws-stage')?.textContent).toContain('读整串')
    expect(q('ws-stage-open')).toBeNull()
  })

  it('卡上带几道检查与「品牌号在这串里说过 N 次」', async () => {
    state = {
      kind: 'ok',
      snapshot: snap({
        progress: { configured: true, reading: false, drafting: 0, pending: 1 },
        cards: [
          {
            id: 'ap_1',
            version: 1,
            kind: 'reply',
            subreddit: 'ivraxr',
            title: '回复 alice',
            parent_author: 'alice',
            parent_text: 'Does it fit prescription frames?',
            draft: { text: 'Yes, with the clip-on insert.' },
            checks: [{ kind: 'ungrounded', message: '「2 年保修」没依据，已改掉', fixed: true }],
            prior_replies: [
              { text: 'We have a clip-on insert.', created_at: '2026-10-12T08:00:00.000Z' },
            ],
            created_at: '2026-10-18T01:00:00.000Z',
          },
        ],
      }),
      reddit_here: true,
    }
    await mount()
    expect(q('ws-prior')?.textContent).toContain('说过 1 次')
    expect(q('ws-check')?.textContent).toBe('没依据的已改掉')
    expect(q('ws-check')?.getAttribute('title')).toContain('2 年保修')
  })

  it('WP419（决策 1231）等你发的社媒帖子：打开发帖页、发好了带链接、不发了；角标算它', async () => {
    state = {
      kind: 'ok',
      snapshot: snap({
        progress: { configured: true, reading: false, drafting: 0, pending: 0 },
        can_post: true,
        posts: [
          {
            id: 'sp_x',
            channel: 'x',
            channel_label: 'X',
            account: 'Nordvolt',
            body: 'Weekend camping checklist',
            kind: 'post',
            scheduled_at: '2026-10-19T02:00:00.000Z',
            compose_url: 'https://x.com/intent/post?text=Weekend%20camping%20checklist',
            prefilled: true,
            media: 1,
            handed_at: '2026-10-19T02:00:00.000Z',
          },
        ],
      }),
      reddit_here: true,
    }
    await mount()
    expect(q('ws-tab-todo')?.textContent).toContain('1')
    expect(q('ws-post-body')?.textContent).toBe('Weekend camping checklist')
    expect(host.textContent).toContain('正文已预填')
    expect(host.textContent).toContain('素材 1 个')
    await click(q('ws-post-open'))
    expect(sent).toContainEqual({
      type: 'open-social-compose',
      url: 'https://x.com/intent/post?text=Weekend%20camping%20checklist',
    })
    const input = q('ws-post-link') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'https://x.com/nordvolt/status/1',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(q('ws-post-done'))
    expect(sent).toContainEqual({
      type: 'panel-post-done',
      id: 'sp_x',
      link: 'https://x.com/nordvolt/status/1',
    })
    await click(q('ws-post-skip'))
    expect(sent).toContainEqual({ type: 'panel-post-skip', id: 'sp_x' })
  })

  it('发帖页只开那几家的站（https）', () => {
    expect(composeUrlAllowed('https://x.com/intent/post?text=a')).toBe(true)
    expect(composeUrlAllowed('https://www.linkedin.com/feed/?shareActive=true')).toBe(true)
    expect(composeUrlAllowed('https://studio.youtube.com/')).toBe(true)
    expect(composeUrlAllowed('http://x.com/')).toBe(false)
    expect(composeUrlAllowed('https://evil.example/')).toBe(false)
    expect(composeUrlAllowed('https://x.com.evil.example/')).toBe(false)
  })

  it('工坊卡地址只拼本机回环、id 认不出不拼', () => {
    expect(workshopCardUrl(4317, 'ap_x-1')).toBe('http://127.0.0.1:4317/cards/ap_x-1')
    expect(workshopCardUrl(4317, '../evil')).toBeUndefined()
    expect(workshopCardUrl(4317, 'a?b=1')).toBeUndefined()
    expect(workshopCardUrl(0, 'ap_1')).toBeUndefined()
  })
})

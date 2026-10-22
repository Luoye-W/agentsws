// @vitest-environment jsdom
/**
 * WP456-T7（§3.12）：插件侧边栏换成工作台同一套视觉档位——只换样子、不改行为：
 *
 * - 顶上「今天发了 N 条 · 等你发 N 条」是一行灰字、数字加粗，不再是两颗像按钮的灰药丸；
 * - 「等你发」：展开的那一条是一张卡，连着收起的几条并成一张列表组；**改过的草稿收起 / 换一条看都不丢**；
 * - 交给插件之后的那几行：状态是「点 + 字」的药丸，细的那句另起一行；失败卡上「再填一次」照旧；
 * - 令牌不再手抄：侧边栏、设置页、红人面板都只引生成的 `tokens.css`，自己的 CSS 里不再定义 `--ws-*`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PanelCard, PanelSnapshot, PanelWrite } from '@agentsws/browser-action'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtensionMessage, ExtensionResponse } from '../src/lib/messages'
import { markOs } from '../src/ui/mark-os'
import { writePill } from '../src/ui/panel-cards'
import { boldNumbers, deskEntries, deskRuns } from '../src/ui/panel-desk'
import { SidePanel } from '../src/ui/side-panel'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  try {
    globalThis.localStorage?.clear?.()
  } catch {}
})
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)
const all = (id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)]
const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
const click = async (el: Element | null | undefined) => {
  if (el === null || el === undefined) throw new Error('没找到')
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise((r) => setTimeout(r, 0))
  })
}
const setValue = async (el: Element | null, value: string) => {
  if (el === null) throw new Error('没找到')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const NOW = '2026-10-22T09:00:00.000Z'
const card = (id: string, author: string, at: string): PanelCard => ({
  id,
  version: 1,
  kind: 'reply',
  subreddit: 'ivraxr',
  title: `回复 ${author}（Reddit · r/ivraxr）`,
  post_title: 'Does the Air3 work with glasses?',
  parent_author: author,
  parent_text: `${author} asks about glasses.`,
  link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/',
  draft: { text: `Hi ${author}, the insert helps.` },
  reason: '在问戴眼镜能不能用',
  rules: ['No store links'],
  created_at: at,
})
const failed: PanelWrite = {
  job_id: 'rdw_f',
  approval_item_id: 'ap_f',
  state: 'failed',
  subreddit: 'ivraxr',
  label: '回复 carol（Reddit · r/ivraxr）',
  message: '原帖那个标签页被关掉了',
  can_refill: true,
  kind: 'reply',
  queued_at: NOW,
}
const snap = (patch: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  at: NOW,
  workspace_name: 'NordVolt Gear',
  person_name: '王岚',
  can_act: true,
  progress: {
    configured: true,
    reading: false,
    drafting: 0,
    pending: 0,
    sent_today: 3,
    awaiting: 2,
  },
  cards: [
    card('ap_1', 'alice', '2026-10-22T08:00:00.000Z'),
    card('ap_2', 'bob', '2026-10-22T08:30:00.000Z'),
    card('ap_3', 'dave', '2026-10-22T07:00:00.000Z'),
  ],
  writes: [failed],
  records: [],
  sinks: [],
  ...patch,
})

async function harness(s: PanelSnapshot) {
  const sent: ExtensionMessage[] = []
  const send = async (m: ExtensionMessage): Promise<ExtensionResponse | undefined> => {
    sent.push(m)
    if (m.type === 'panel-state')
      return { type: 'panel-state', state: { kind: 'ok', snapshot: s, reddit_here: true } }
    if (m.type.startsWith('panel-')) return { type: 'panel-act', ok: true }
    return { type: 'ack' }
  }
  await act(async () => {
    root.render(
      <SidePanel send={send} refreshMs={60_000} windowId={async () => 7} version="0.2.1" />,
    )
  })
  await tick()
  await tick()
  return { sent }
}

describe('WP456-T7 · 顶上一行', () => {
  it('数字加粗，其余是字（不是一颗颗药丸）', () => {
    const parts = boldNumbers('正在巡查 2/3 块')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe('正在巡查 ')
    expect((parts[1] as { props: { children: string } }).props.children).toBe('2/3')
    expect(boldNumbers('今天发了 0 条').length).toBe(3)
  })

  it('侧边栏顶上：一行灰字，数字是 <b>，没有 ws-chip', async () => {
    await harness(snap())
    const strip = q('ws-strip')
    expect(strip?.textContent).toContain('今天发了 3 条')
    expect(strip?.textContent).toContain('等你发 2 条')
    expect(strip?.querySelectorAll('.ws-chip')).toHaveLength(0)
    expect([...(strip?.querySelectorAll('b') ?? [])].map((b) => b.textContent)).toEqual(['3', '2'])
    // 头部：品牌名 · 人名
    expect(q('ws-who')?.textContent).toBe('NordVolt Gear · 王岚')
  })
})

describe('WP456-T7 · 等你发', () => {
  it('展开的一条单独一张卡，连着收起的几条并成一张列表组', () => {
    const entries = deskEntries(snap().cards, [])
    const runs = deskRuns(entries, entries[1]?.key)
    expect(runs.map((r) => [r.open, r.items.length])).toEqual([
      [false, 1],
      [true, 1],
      [false, 1],
    ])
    expect(deskRuns(entries, entries[0]?.key).map((r) => [r.open, r.items.length])).toEqual([
      [true, 1],
      [false, 2],
    ])
  })

  it('页面上：一张卡 + 一张列表组；节标题带计数；标签是灰底分类标签', async () => {
    await harness(snap())
    const list = q('ws-desk-list')
    expect(list?.querySelectorAll('.ws-desk-card')).toHaveLength(1)
    expect(list?.querySelectorAll('ul.ws-group [data-testid="ws-desk"]')).toHaveLength(2)
    expect(list?.querySelector('.ws-sec-count')?.textContent).toBe('3')
    const open = list?.querySelector('[data-open="1"]')
    expect(open?.querySelector('.ws-tag')?.textContent).toBe('版规 1')
    expect(open?.querySelector('.ws-link')?.textContent).toContain('原帖')
    // 主按钮只有一个（填入），复制是次按钮
    expect(open?.querySelectorAll('.ws-btn--primary')).toHaveLength(1)
    expect(q('ws-desk-copy')?.className).toBe('ws-btn')
  })

  it('改过的草稿：换一条看、再回来，字还在（只换样子，不丢东西）', async () => {
    await harness(snap())
    await setValue(q('ws-desk-draft'), 'Edited by hand.')
    const rows = all('ws-desk').filter((d) => d.getAttribute('data-open') === '0')
    // 打开另一条：刚才那条收进列表组（标「改过」）
    await click(rows[0]?.querySelector('.ws-card-head'))
    const edited = all('ws-desk').find((d) => d.textContent?.includes('改过'))
    expect(edited?.getAttribute('data-open')).toBe('0')
    await click(edited?.querySelector('.ws-card-head'))
    expect((q('ws-desk-draft') as HTMLTextAreaElement).value).toBe('Edited by hand.')
  })
})

describe('WP456-T7 · 交给插件之后的那几行', () => {
  it('状态药丸的几个字', () => {
    const w = (state: PanelWrite['state'], extra: Partial<PanelWrite> = {}) =>
      writePill({ ...failed, state, ...extra })
    expect(w('failed')).toBe('没发出去')
    expect(w('filling')).toBe('等你点发送')
    expect(w('sent')).toBe('已发')
    expect(w('sent', { record_id: 'r1' })).toBe('已发 · 已记录')
  })

  it('失败卡：红药丸「没发出去」+ 那一句原因另起一行；「再填一次」照旧', async () => {
    const { sent } = await harness(snap({ cards: [] }))
    const row = q('ws-write')
    expect(row?.querySelector('.ws-pill--bad')?.textContent).toBe('没发出去')
    expect(row?.querySelector('.ws-write-msg')?.textContent).toBe('原帖那个标签页被关掉了')
    expect(row?.closest('ul')?.className).toContain('ws-group')
    await click(q('ws-refill'))
    expect(sent.some((m) => m.type === 'panel-refill')).toBe(true)
  })
})

describe('WP456-T7 · 令牌只有生成的那一份', () => {
  const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

  it('侧边栏、设置页、红人面板都引 tokens.css，自己的 CSS 里不再定义 --ws-* 颜色', () => {
    expect(read('entrypoints/sidepanel/main.tsx')).toContain("import '@/ui/tokens.css'")
    expect(read('entrypoints/options/main.tsx')).toContain("import '@/ui/tokens.css'")
    expect(read('entrypoints/kol.content.tsx')).toContain("import '@/ui/tokens.css'")
    for (const css of [
      'entrypoints/sidepanel/sidepanel.css',
      'entrypoints/options/options.css',
      'ui/kol-panel.css',
    ])
      expect(read(css)).not.toMatch(/^\s*--ws-[a-z-]+\s*:/mu)
    expect(read('ui/tokens.css')).toMatch(/生成文件，别手改/u)
  })

  it('Windows 上挂 data-os（细滚动条），Mac 不挂', () => {
    const doc = document.implementation.createHTMLDocument('x')
    markOs(doc, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(doc.documentElement.dataset.os).toBe('windows')
    const mac = document.implementation.createHTMLDocument('y')
    markOs(mac, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(mac.documentElement.dataset.os).toBeUndefined()
  })
})

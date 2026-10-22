// @vitest-environment jsdom
/**
 * WP445（决策 1322 / 1323，Luoye 10-21）：插件这一侧的「审与发一步完成」——
 *
 * - 「等你发」里：插件里审的卡（还没批）与主管批过的那一条**同一个样子**；卡在前；
 * - 卡上点「打开这一条」= 批 + 打开（`panel-fill` 带改过的字、版本、窗口）；写上点 = `panel-open`；
 * - 「不发」：快捷理由（不相关 / 时机不对 / 不想回 / 其他…）或「不写理由」，点哪个都一下就不发；
 *   写了理由、同类的也一并不发了 → 顶上一行「另外 N 条同类的也不发了 · 撤回」；
 * - 「稍后」按条记（卡与写都行）；
 * - 图标数字把还没审的卡也算上（同一张卡只算一条）；
 * - 横条：Reddit 这条路中性色、「草稿已填好，请检查后自己点发送」；广告那边照旧「AI 正在操作」。
 */
import type { PanelCard, PanelSnapshot, PanelWrite } from '@agentsws/browser-action'
import { SOFT_MISS_LABEL } from '@agentsws/browser-action'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASSIST_READY, bannerText, renderBanner } from '../src/lib/ads/banner'
import type { ExtensionMessage, ExtensionResponse } from '../src/lib/messages'
import { waitingOf } from '../src/lib/waiting'
import { deskEntries } from '../src/ui/panel-desk'
import { SidePanel } from '../src/ui/side-panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const NOW = '2026-10-21T09:00:00.000Z'
const card = (id: string, author: string, at = NOW): PanelCard => ({
  id,
  version: 1,
  kind: 'reply',
  subreddit: 'ivraxr',
  title: `回复 ${author}（Reddit · r/ivraxr）`,
  post_title: 'Does the Air3 work with glasses?',
  parent_author: author,
  parent_text: 'Mine fogs up a bit.',
  link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/',
  draft: { text: `Hi ${author}, the insert helps.` },
  reason: '在问戴眼镜能不能用',
  created_at: at,
})
const approved: PanelWrite = {
  job_id: 'rdw_9',
  approval_item_id: 'ap_boss',
  state: 'awaiting',
  subreddit: 'ivraxr',
  label: '发帖：Weekly Q&A（Reddit · r/ivraxr）',
  queued_at: NOW,
  kind: 'submit',
  title: 'Weekly Q&A',
  text: 'Ask anything here.',
}

const snap = (patch: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  at: NOW,
  workspace_name: 'IVRA',
  can_act: true,
  progress: { configured: true, reading: false, drafting: 0, pending: 0, awaiting: 3 },
  cards: [card('ap_1', 'alice', '2026-10-21T08:00:00.000Z'), card('ap_2', 'bob')],
  writes: [approved],
  records: [],
  sinks: [],
  notify_system: true,
  ...patch,
})

async function harness(s: PanelSnapshot, reply?: (m: ExtensionMessage) => ExtensionResponse) {
  const sent: ExtensionMessage[] = []
  const send = async (m: ExtensionMessage): Promise<ExtensionResponse | undefined> => {
    sent.push(m)
    if (m.type === 'panel-state')
      return { type: 'panel-state', state: { kind: 'ok', snapshot: s, reddit_here: true } }
    if (reply !== undefined) return reply(m)
    if (m.type.startsWith('panel-')) return { type: 'panel-act', ok: true }
    return { type: 'ack' }
  }
  await act(async () => {
    root.render(
      <SidePanel send={send} refreshMs={60_000} windowId={async () => 7} version="0.2.1-beta.5" />,
    )
  })
  await tick()
  await tick()
  return { sent }
}

describe('WP445 「等你发」：插件里审的卡与主管批过的同一个样子', () => {
  it('卡在前（新的在前）、批过的接在后面；同一张卡只算一条', () => {
    const e = deskEntries(snap().cards, [
      approved,
      { ...approved, job_id: 'rdw_dup', approval_item_id: 'ap_1' },
      { ...approved, job_id: 'rdw_f', state: 'filling' },
    ])
    expect(e.map((x) => x.key)).toEqual(['c:ap_2', 'c:ap_1', 'w:rdw_9'])
  })

  it('图标数字把还没审的卡也算上；同一张卡只算一条', () => {
    expect(waitingOf(snap()).map((w) => w.id)).toEqual(['c:ap_1', 'c:ap_2', 'w:rdw_9'])
    expect(
      waitingOf(snap({ writes: [{ ...approved, approval_item_id: 'ap_1', job_id: 'rdw_x' }] })).map(
        (w) => w.id,
      ),
    ).toEqual(['c:ap_1', 'c:ap_2'])
  })

  it('三条都在「等你发」里；顶上 tab 数 3；卡上「打开这一条」= 批 + 打开（带改过的字、版本、窗口）', async () => {
    const h = await harness(snap())
    expect(all('ws-desk')).toHaveLength(3)
    expect(all('ws-desk').map((x) => x.getAttribute('data-from'))).toEqual([
      'card',
      'card',
      'write',
    ])
    expect(q('ws-tab-todo')?.textContent).toContain('3')
    // 工坊那种「批准并打开」的卡块没有了
    expect(q('ws-card')).toBeNull()
    await setValue(q('ws-desk-draft'), 'Hi Bob, edited.')
    await click(q('ws-desk-open'))
    expect(h.sent).toContainEqual({
      type: 'panel-fill',
      id: 'ap_2',
      version: 1,
      text: 'Hi Bob, edited.',
      windowId: 7,
    })
  })

  it('主管批过的那一条：打开 = panel-open（带窗口）；发帖能改标题', async () => {
    const h = await harness(snap({ cards: [] }))
    expect(q('ws-desk')?.getAttribute('data-from')).toBe('write')
    await setValue(host.querySelector('input[aria-label="标题"]'), 'Weekly Q&A #2')
    await click(q('ws-desk-open'))
    expect(h.sent).toContainEqual({
      type: 'panel-open',
      job: 'rdw_9',
      title: 'Weekly Q&A #2',
      windowId: 7,
    })
  })

  it('不发：快捷理由一下就不发（带理由）；同类的也一并不发了 → 顶上一行能撤回', async () => {
    const h = await harness(snap(), (m) =>
      m.type === 'panel-skip'
        ? {
            type: 'panel-act',
            ok: true,
            followed: { leader_id: 'ap_2', ids: ['ap_1'], titles: ['回复 alice'] },
          }
        : { type: 'panel-act', ok: true },
    )
    await click(q('ws-desk-skip'))
    const chips = all('ws-skip-reason')
    expect(chips.map((c) => c.textContent)).toEqual(['不相关', '时机不对', '不想回'])
    await click(chips[0])
    expect(h.sent).toContainEqual({ type: 'panel-skip', id: 'ap_2', version: 1, reason: '不相关' })
    expect(q('ws-follow')?.textContent).toContain('另外 1 条同类的也不发了')
    await click(q('ws-follow-undo'))
    expect(h.sent).toContainEqual({ type: 'panel-follow-undo', leader: 'ap_2', ids: ['ap_1'] })
    expect(q('ws-follow')).toBeNull()
  })

  it('不发：「其他…」自己写一句；「算了，还要发」回去；批过的那一条不发走 panel-drop', async () => {
    const h = await harness(snap({ cards: [] }))
    await click(q('ws-desk-skip'))
    await click(q('ws-desk-skip-cancel'))
    expect(q('ws-desk-open')).not.toBeNull()
    await click(q('ws-desk-skip'))
    await click(q('ws-desk-reason-other'))
    await setValue(q('ws-desk-reason-text'), '这周不发帖')
    await click(q('ws-desk-reason-save'))
    expect(h.sent).toContainEqual({ type: 'panel-drop', job: 'rdw_9', reason: '这周不发帖' })
  })

  it('稍后：按条记（卡也行），收到最下面一行', async () => {
    await harness(snap())
    await click(q('ws-desk-later'))
    expect(all('ws-desk')).toHaveLength(2)
    expect(q('ws-desk-parked')?.textContent).toContain('1 条')
  })
})

describe('WP445 横条：Reddit 这条路是中性的「草稿已填好」', () => {
  it('Reddit：填好后说「草稿已填好，请检查后自己点发送」、中性色；填的时候说在填草稿；对不上照实说', () => {
    expect(
      bannerText({ title: 'x', step: 6, of: 6, label: '填好了，等你点发送', assist: true }),
    ).toBe(ASSIST_READY)
    expect(bannerText({ title: 'x', step: 2, of: 6, label: '等页面', assist: true })).toBe(
      '正在填草稿 · 2/6 · 等页面',
    )
    expect(
      bannerText({
        title: 'x',
        step: 6,
        of: 6,
        label: SOFT_MISS_LABEL,
        assist: true,
      }),
    ).toBe(SOFT_MISS_LABEL)
    const doc = document.implementation.createHTMLDocument('r')
    renderBanner(
      doc,
      { title: 'x', step: 6, of: 6, label: '填好了，等你点发送', assist: true },
      { onStop: () => {}, onConfirm: () => {} },
    )
    const bar = doc.getElementById('agentsws-ads-banner')?.shadowRoot?.querySelector('.bar')
    expect(bar?.className).toBe('bar assist')
    expect(bar?.textContent).toContain(ASSIST_READY)
    expect(bar?.textContent).not.toContain('AI 正在操作')
  })

  it('广告那边真在操作：照旧红色「AI 正在操作」', () => {
    expect(bannerText({ title: 'x', step: 2, of: 7, label: '点暂停' })).toBe(
      'AI 正在操作 · 2/7 · 点暂停',
    )
    const doc = document.implementation.createHTMLDocument('a')
    renderBanner(
      doc,
      { title: 'x', step: 2, of: 7, label: '点暂停' },
      {
        onStop: () => {},
        onConfirm: () => {},
      },
    )
    expect(
      doc.getElementById('agentsws-ads-banner')?.shadowRoot?.querySelector('.bar')?.className,
    ).toBe('bar')
  })
})

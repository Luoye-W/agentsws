// @vitest-environment jsdom
/**
 * WP432（Luoye 10-20 反馈 9，最急）：插件这一侧的「半自动发帖」——
 *
 * - **插件从不自己开 Reddit 页面**：定时领活就算领到了 Reddit 的写（老本机服务），也不开、照实交回去；
 * - 图标上「等你发」的数字；新来的弹一句通知（第一次看到不一口气弹一串；工坊里关了「等你发」的系统通知就不弹）；
 * - 侧边栏发帖台：等你发的那一条带原帖、被回的那句、为什么回、草稿全文；改了字点「打开这一条」带改过的字和窗口；
 *   复制草稿、稍后、不发了；顶上一行实时状况；底下版本对不上就说怎么重新加载。
 */
import type { PanelSnapshot, PanelWrite } from '@agentsws/browser-action'
import { buildRedditJob } from '@agentsws/browser-action'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PermissionsLike } from '../src/lib/ads/permissions'
import { pollAdsOnce, REDDIT_NOT_AUTO } from '../src/lib/ads/poller'
import { PAIRED_BADGE_TEXT, WAITING_BADGE_COLOR } from '../src/lib/badge'
import type { ExtensionMessage, ExtensionResponse } from '../src/lib/messages'
import { memoryStore, SETTINGS_KEY } from '../src/lib/storage'
import { refreshWaiting, waitingOf } from '../src/lib/waiting'
import { SidePanel } from '../src/ui/side-panel'
import { fakeLocal } from './ads-fakes'

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
const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
const click = async (el: Element | null) => {
  if (el === null) throw new Error('没找到')
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise((r) => setTimeout(r, 0))
  })
}
const setValue = async (el: Element | null, value: string) => {
  if (el === null) throw new Error('没找到')
  await act(async () => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    )
  })
}

const NOW = '2026-10-21T09:00:00.000Z'
const REDDIT = ['https://old.reddit.com/*', 'https://www.reddit.com/*']
const perms = (granted: string[]): PermissionsLike => ({
  contains: async (p) => (p.origins ?? []).every((o) => granted.includes(o)),
  request: async () => true,
  remove: async () => true,
})

const awaiting: PanelWrite = {
  job_id: 'rdw_1',
  approval_item_id: 'ap_1',
  state: 'awaiting',
  subreddit: 'ivraxr',
  label: '回复 alice（Reddit · r/ivraxr）',
  queued_at: NOW,
  kind: 'reply',
  text: 'Hi Alice — the Air3 fits over most frames.',
  post_title: 'Does the Air3 work with glasses?',
  parent_author: 'alice',
  parent_text: 'Mine fogs up a bit when I wear glasses.',
  thread_link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/',
  reason: '在问戴眼镜能不能用',
}

const snap = (patch: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  at: NOW,
  workspace_name: 'IVRA',
  can_act: true,
  progress: {
    configured: true,
    reading: true,
    drafting: 0,
    pending: 0,
    sent_today: 2,
    awaiting: 1,
    last_run: {
      started_at: NOW,
      trigger: 'schedule',
      pending: 0,
      parts: [
        { part: 'inbox', status: 'ok', fetched: 1, fresh: 1 },
        { part: 'own_sub', status: 'waiting', fetched: 0, fresh: 0 },
      ],
    },
  },
  cards: [],
  writes: [awaiting],
  records: [],
  sinks: [],
  versions: { workshop: '0.2.1-beta.5', folder: '0.2.1-beta.5' },
  notify_system: true,
  ...patch,
})

describe('WP432 插件从不自己开 Reddit 页面', () => {
  it('定时领活领到了 Reddit 的写（老本机服务）：不开标签页、照实交回去', async () => {
    const job = buildRedditJob({
      id: 'rdw_9',
      workspace_id: 'ws',
      account_id: 'ivra_official',
      action: {
        write: { kind: 'reply', parent: 't1_c1', permalink: '/r/ivraxr/comments/abc/s/c1/' },
        text: 'Hi',
      },
      approval_id: 'ap_9',
      created_at: NOW,
    })
    const local = fakeLocal({ job })
    let opened = 0
    const out = await pollAdsOnce({
      store: memoryStore({ [SETTINGS_KEY]: { port: 4399, token: 'ext_t' } }),
      perms: perms(REDDIT),
      fetch: local.fetch,
      openTab: async () => {
        opened += 1
        return { why: 'x' }
      },
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      waitSeconds: 0,
    })
    expect(out).toBe('ran')
    expect(opened).toBe(0)
    const result = local.calls.find((c) => c.path.endsWith('/result'))
    expect(result?.body).toMatchObject({ outcome: 'handover', message: REDDIT_NOT_AUTO })
  })
})

describe('WP432 图标上的数字与通知', () => {
  const action = () => {
    const calls: { text?: string; color?: string; title?: string }[] = []
    return {
      calls,
      port: {
        setBadgeText: (d: { text: string }) => void calls.push({ text: d.text }),
        setBadgeBackgroundColor: (d: { color: string }) => void calls.push({ color: d.color }),
        setTitle: (d: { title: string }) => void calls.push({ title: d.title }),
      },
    }
  }
  const store = () => memoryStore({ [SETTINGS_KEY]: { port: 4399, token: 'ext_t' } })

  it('等你发 = 批了等你打开的写 + 交给你发的社媒帖子', () => {
    expect(waitingOf(snap()).map((w) => w.id)).toEqual(['w:rdw_1'])
    expect(waitingOf(snap({ writes: [{ ...awaiting, state: 'filling' }] }))).toEqual([])
  })

  it('有等你发的出数字（提醒色）；第一次看到只记下不弹；之后新来的弹一句；没有了回到绿勾', async () => {
    const s = store()
    const a = action()
    const notes: string[] = []
    const deps = { store: s, action: a.port, notify: (i: { label: string }) => notes.push(i.label) }
    await refreshWaiting(deps, snap())
    expect(a.calls).toContainEqual({ text: '1' })
    expect(a.calls).toContainEqual({ color: WAITING_BADGE_COLOR })
    expect(notes).toEqual([])
    const second = { ...awaiting, job_id: 'rdw_2', label: '回帖：Battery life' }
    await refreshWaiting(deps, snap({ writes: [awaiting, second] }))
    expect(a.calls).toContainEqual({ text: '2' })
    expect(notes).toEqual(['回帖：Battery life'])
    // 同一条不再弹
    await refreshWaiting(deps, snap({ writes: [awaiting, second] }))
    expect(notes).toHaveLength(1)
    await refreshWaiting(deps, snap({ writes: [] }))
    expect(a.calls.at(-3)).toEqual({ color: '#158a4b' })
    expect(a.calls).toContainEqual({ text: PAIRED_BADGE_TEXT })
  })

  it('工坊设置里关了「等你发」的系统通知：数字照出，不弹', async () => {
    const s = store()
    const a = action()
    const notes: string[] = []
    const deps = { store: s, action: a.port, notify: (i: { label: string }) => notes.push(i.label) }
    await refreshWaiting(deps, snap({ writes: [], notify_system: false }))
    await refreshWaiting(deps, snap({ notify_system: false }))
    expect(a.calls).toContainEqual({ text: '1' })
    expect(notes).toEqual([])
  })
})

describe('WP432 侧边栏发帖台', () => {
  const harness = async (s: PanelSnapshot) => {
    const sent: ExtensionMessage[] = []
    const copied: string[] = []
    const send = async (m: ExtensionMessage): Promise<ExtensionResponse | undefined> => {
      sent.push(m)
      if (m.type === 'panel-state')
        return { type: 'panel-state', state: { kind: 'ok', snapshot: s, reddit_here: true } }
      if (m.type.startsWith('panel-')) return { type: 'panel-act', ok: true }
      return { type: 'ack' }
    }
    await act(async () => {
      root.render(
        <SidePanel
          send={send}
          refreshMs={60_000}
          windowId={async () => 42}
          copy={async (t) => {
            copied.push(t)
            return true
          }}
          version="0.2.1-beta.5"
        />,
      )
    })
    await tick()
    await tick()
    return { sent, copied }
  }

  it('顶上实时状况；等你发这一条带原帖、被回的那句、为什么回、草稿全文', async () => {
    await harness(snap())
    const strip = q('ws-strip')?.textContent ?? ''
    expect(strip).toContain('正在巡查 2/2 块')
    expect(strip).toContain('今天发了 2 条')
    expect(strip).toContain('等你发 1 条')
    const desk = q('ws-desk')?.textContent ?? ''
    expect(desk).toContain('回复 u/alice · r/ivraxr')
    expect(desk).toContain('Does the Air3 work with glasses?')
    expect(q('ws-desk-quote')?.textContent).toContain('fogs up')
    expect(q('ws-desk-reason')?.textContent).toContain('戴眼镜')
    expect((q('ws-desk-draft') as HTMLTextAreaElement).value).toBe(awaiting.text)
    expect(q('ws-tab-todo')?.textContent).toContain('1')
  })

  it('改了字点「打开这一条」：带改过的字和侧边栏所在的窗口；复制草稿；不发（WP445：理由可选）', async () => {
    const h = await harness(snap())
    await setValue(q('ws-desk-draft'), 'Edited here')
    await click(q('ws-desk-copy'))
    expect(h.copied).toEqual(['Edited here'])
    await click(q('ws-desk-open'))
    await tick()
    expect(h.sent).toContainEqual({
      type: 'panel-open',
      job: 'rdw_1',
      text: 'Edited here',
      windowId: 42,
    })
    await click(q('ws-desk-skip'))
    await click(q('ws-desk-skip-now'))
    await tick()
    expect(h.sent).toContainEqual({ type: 'panel-drop', job: 'rdw_1' })
  })

  it('稍后：收到最下面一行，点开又回来', async () => {
    await harness(snap())
    await click(q('ws-desk-later'))
    expect(q('ws-desk')).toBeNull()
    await click(q('ws-desk-parked'))
    expect(q('ws-desk')).not.toBeNull()
  })

  it('WP445：版本对不上时顶上临时一条（说怎么重新加载、能点「现在更新」）；底部那一栏与新版旧版开关都没了', async () => {
    const h = await harness(
      snap({ versions: { workshop: '0.2.1-beta.6', folder: '0.2.1-beta.6' } }),
    )
    const warn = q('ws-version-warn')
    expect(warn?.textContent).toContain('chrome://extensions')
    // 在顶上（侧边栏第一块内容之前），不在底下
    expect(host.querySelector('.ws-side > *:nth-child(2)')?.getAttribute('data-testid')).toBe(
      'ws-version-warn',
    )
    await click(warn?.querySelector('button') ?? null)
    expect(h.sent).toContainEqual({ type: 'update-check' })
    expect(q('ws-foot')).toBeNull()
    expect(q('ws-versions')).toBeNull()
    expect(q('ws-site')).toBeNull()
  })

  it('版本一样：一个字都不画', async () => {
    await harness(snap())
    expect(q('ws-version-warn')).toBeNull()
    expect(q('ws-foot')).toBeNull()
  })
})

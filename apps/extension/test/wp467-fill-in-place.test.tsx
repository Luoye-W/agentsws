// @vitest-environment jsdom
/**
 * WP467（Luoye 10-22 Windows 真机）：插件这一侧——
 *
 * - 「填入」先挑**用户已经开着的原帖页**（按帖子 id，只认 www，不认 old.reddit），没开着才新开；
 * - 就地填：标签页已经在这个帖子上就不跳转；
 * - 标签页出事的话按动作类型说（Reddit 说「原帖那个标签页被关掉了」，不再借广告后台的话）；
 * - 人自己发出去的（插件填好后点的、复制粘贴的）：这个帖子里 + 文本相近 + 当前登录的号 + 草稿出来之后才发的，就记；
 *   错帖不记、别人发的不记、早就有的不记；
 * - 「认最近一条」读这个帖子里这个号最新的那一条；
 * - 侧边栏：按钮叫「填入」「复制」，「我发了，帮我记一下」贴链接 / 认最近一条。
 */
import type {
  ActionJob,
  PanelCard,
  PanelSnapshot,
  PanelWrite,
  PostedHit,
} from '@agentsws/browser-action'
import { buildRedditJob, redditJobOnWww } from '@agentsws/browser-action'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executeJob } from '../src/lib/ads/executor'
import { pickRedditTab, redditJobPost } from '../src/lib/ads/open-tab'
import { type TabDriver, TabPage, tabWording } from '../src/lib/ads/tab-page'
import type { ExtensionMessage, ExtensionResponse } from '../src/lib/messages'
import {
  hitMatches,
  latestSent,
  type WatchTarget,
  watchSentOnce,
  watchTargets,
} from '../src/lib/reddit/sent-watch'
import { SidePanel } from '../src/ui/side-panel'

import { fakeLocal } from './ads-fakes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = '2026-10-22T09:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const DRAFT = 'Hi Alice, the Air3 fits over most prescription frames.'

const replyJob = (permalink = '/r/ivraxr/comments/abc/comment/c1/'): ActionJob =>
  buildRedditJob({
    id: 'rdw_1',
    workspace_id: 'ws',
    account_id: 'ivra_official',
    action: { write: { kind: 'reply', parent: 't1_c1', permalink }, text: DRAFT },
    approval_id: 'ap_1',
    created_at: NOW,
  })

describe('WP467 「填入」先找开着的原帖页', () => {
  it('按帖子 id 挑：侧边栏所在窗口正在看的最先；别的帖子、old.reddit 不算', () => {
    const tabs = [
      { id: 1, url: 'https://old.reddit.com/r/ivraxr/comments/abc/x/', active: true, windowId: 7 },
      { id: 2, url: 'https://www.reddit.com/r/ivraxr/comments/zzz/x/', active: true, windowId: 7 },
      {
        id: 3,
        url: 'https://www.reddit.com/r/ivraxr/comments/abc/does_it_work/?utm_source=share',
        active: false,
        windowId: 9,
        lastAccessed: 5,
      },
      {
        id: 4,
        url: 'https://www.reddit.com/r/ivraxr/comments/abc/comment/c1/',
        active: false,
        windowId: 7,
        lastAccessed: 1,
      },
      {
        id: 5,
        url: 'https://www.reddit.com/r/ivraxr/comments/abc/',
        active: true,
        windowId: 7,
      },
    ]
    expect(pickRedditTab(tabs, 'abc', 7)?.id).toBe(5)
    expect(pickRedditTab(tabs.slice(0, 4), 'abc', 7)?.id).toBe(4)
    expect(pickRedditTab(tabs.slice(0, 3), 'abc', 7)?.id).toBe(3)
    expect(pickRedditTab(tabs.slice(0, 2), 'abc', 7)).toBeUndefined()
  })

  it('这件活写到哪个帖子；老活里写着 old.reddit 的换成 www', () => {
    expect(redditJobPost(replyJob())).toBe('abc')
    const old = replyJob()
    const first = old.plan.steps[0]
    if (first?.op !== 'goto') throw new Error('第一步应该是打开页面')
    const stale: ActionJob = {
      ...old,
      plan: {
        ...old.plan,
        steps: [{ ...first, url: 'https://old.reddit.com/r/ivraxr/comments/abc/x/c1/' }],
      },
    }
    const fixed = redditJobOnWww(stale).plan.steps[0]
    expect(fixed?.op === 'goto' && fixed.url).toBe(
      'https://www.reddit.com/r/ivraxr/comments/abc/x/c1/',
    )
  })
})

/** 一个只在内存里的「标签页」（不放页面脚本，只看网址与开关）。 */
function fakeDriver(url: string | undefined, dom: (req: unknown) => unknown = () => 0) {
  const nav: string[] = []
  let current = url
  const d: TabDriver = {
    facts: async () =>
      current === undefined
        ? undefined
        : { url: current, status: 'complete', active: true, windowId: 1 },
    navigate: async (u) => {
      nav.push(u)
      // 关掉了的标签页换不了页
      if (current !== undefined) current = u
    },
    activate: async () => {},
    inject: async () => {},
    dom: async (req) => dom(req) as never,
    banner: async () => {},
    capture: async () => '',
    downloadsAllowed: async () => false,
    watchDownload: async () => ({ ok: false, why: 'no' }),
    sleep: async () => {},
  }
  return {
    d,
    nav,
    close: () => {
      current = undefined
    },
  }
}

describe('WP467 就地填与标签页出事时的话', () => {
  it('标签页已经在这个帖子上：就地用（那条评论也在页面上才算）', async () => {
    const t = fakeDriver('https://www.reddit.com/r/ivraxr/comments/abc/does/', () => 1)
    const page = new TabPage({ driver: t.d, hosts: ['www.reddit.com'], bannerState: () => null })
    expect(await page.stay('abc', 'shreddit-comment[thingid="t1_c1"]')).toBe(true)
    expect(await page.stay('zzz')).toBe(false)
    const none = fakeDriver('https://www.reddit.com/r/ivraxr/comments/abc/does/', () => 0)
    const p2 = new TabPage({ driver: none.d, hosts: ['www.reddit.com'], bannerState: () => null })
    expect(await p2.stay('abc', 'shreddit-comment[thingid="t1_c1"]')).toBe(false)
    // 白名单外的站不算
    const off = fakeDriver('https://example.com/r/ivraxr/comments/abc/', () => 1)
    const p3 = new TabPage({ driver: off.d, hosts: ['www.reddit.com'], bannerState: () => null })
    expect(await p3.stay('abc')).toBe(false)
  })

  it('原帖那个标签页被关掉了：卡上说 Reddit 的话，不说「广告后台」', async () => {
    const t = fakeDriver(undefined)
    const local = fakeLocal({})
    const r = await executeJob(replyJob(), {
      client: { port: 1, token: 't', fetch: local.fetch },
      driver: t.d,
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      gapMs: 0,
    })
    expect(r.message).toContain('原帖那个标签页被关掉了')
    expect(r.message).not.toContain('广告后台')
    expect(tabWording('google_ads').closed).toContain('广告后台')
  })
})

const card = (patch: Partial<PanelCard> = {}): PanelCard => ({
  id: 'ap_1',
  version: 3,
  kind: 'reply',
  subreddit: 'ivraxr',
  title: '回复 alice（Reddit · r/ivraxr）',
  link: 'https://www.reddit.com/r/ivraxr/comments/abc/comment/c1/',
  target_post: 'abc',
  target_parent: 't1_c1',
  draft: { text: DRAFT },
  created_at: '2026-10-22T08:00:00.000Z',
  ...patch,
})
const write = (patch: Partial<PanelWrite> = {}): PanelWrite => ({
  job_id: 'rdw_2',
  approval_item_id: 'ap_2',
  state: 'awaiting',
  subreddit: 'ivraxr',
  queued_at: '2026-10-22T08:30:00.000Z',
  kind: 'comment',
  text: 'Thanks for asking! It works with most frames.',
  target_post: 'abc',
  ...patch,
})
const snap = (patch: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  at: NOW,
  can_act: true,
  progress: {
    configured: true,
    reading: false,
    drafting: 0,
    pending: 0,
    awaiting: 2,
    account: 'ivra_official',
  },
  cards: [card()],
  writes: [write()],
  records: [],
  sinks: [],
  notify_system: true,
  ...patch,
})

describe('WP467 人自己发出去的照样记', () => {
  it('要盯的：还没批的卡、等你发的、24 小时内没发出去的；正在填的、已记的、发新帖不盯', () => {
    const t = watchTargets(
      snap({
        writes: [
          write(),
          write({ job_id: 'rdw_f', approval_item_id: 'ap_f', state: 'filling' }),
          write({
            job_id: 'rdw_x',
            approval_item_id: 'ap_x',
            state: 'failed',
            finished_at: '2026-10-22T07:00:00.000Z',
          }),
          write({
            job_id: 'rdw_old',
            approval_item_id: 'ap_old',
            state: 'failed',
            finished_at: '2026-10-19T07:00:00.000Z',
          }),
          write({ job_id: 'rdw_s', approval_item_id: 'ap_s', kind: 'submit' }),
          write({ job_id: 'rdw_dup', approval_item_id: 'ap_1' }),
        ],
      }),
      NOW_MS,
    )
    expect(t.map((x) => x.key)).toEqual(['c:ap_1', 'w:rdw_2', 'w:rdw_x'])
    expect(t[0]).toMatchObject({ kind: 'reply', post: 'abc', parent: 't1_c1' })
    // 人点「我发了，帮我记一下」：正在填的、早就没发出去的也算
    expect(
      watchTargets(
        snap({
          cards: [],
          writes: [
            write({ job_id: 'rdw_f', state: 'filling' }),
            write({ job_id: 'rdw_old', state: 'failed', finished_at: '2026-10-01T00:00:00Z' }),
          ],
        }),
        NOW_MS,
        { manual: true },
      ).map((x) => x.key),
    ).toEqual(['w:rdw_f', 'w:rdw_old'])
  })

  const target: WatchTarget = {
    key: 'w:rdw_2',
    job: 'rdw_2',
    kind: 'comment',
    post: 'abc',
    text: 'Thanks for asking! It works with most frames.',
    since_ms: Date.parse('2026-10-22T08:30:00.000Z'),
  }
  const hit = (p: Partial<PostedHit> = {}): PostedHit => ({
    fullname: 't1_new1',
    permalink: '/r/ivraxr/comments/abc/comment/new1/',
    author: 'ivra_official',
    text: 'Thanks for asking! It works with most glasses frames.',
    created_ms: Date.parse('2026-10-22T08:40:00.000Z'),
    ...p,
  })

  it('认法：同一个号、字相近、草稿出来之后才发的；别的号 / 早就有的 / 差太多的都不算', () => {
    expect(hitMatches(target, hit(), 'ivra_official')).toBe(true)
    expect(hitMatches(target, hit({ author: 'someone_else' }), 'ivra_official')).toBe(false)
    expect(
      hitMatches(target, hit({ created_ms: Date.parse('2026-10-20T00:00:00Z') }), 'ivra_official'),
    ).toBe(false)
    expect(hitMatches(target, hit({ text: 'Price in Japan is 399.' }), 'ivra_official')).toBe(false)
  })

  it('只在这个帖子的标签页里找；认出来记一次，同一条不记两次', async () => {
    const asked: number[] = []
    const recorded: string[] = []
    const deps = {
      tabs: async () => [
        { id: 1, url: 'https://www.reddit.com/r/ivraxr/comments/zzz/other/' },
        { id: 2, url: 'https://www.reddit.com/r/ivraxr/comments/abc/x/?utm_source=share' },
        { id: 3, url: 'https://old.reddit.com/r/ivraxr/comments/abc/x/' },
      ],
      find: async (tabId: number) => {
        asked.push(tabId)
        return [hit()]
      },
      me: async () => 'ivra_official',
      record: async (t: WatchTarget) => {
        recorded.push(t.key)
        return true
      },
    }
    const done = new Set<string>()
    expect(await watchSentOnce([target], deps, done)).toBe(1)
    expect(asked).toEqual([2])
    expect(recorded).toEqual(['w:rdw_2'])
    expect(await watchSentOnce([target], deps, done)).toBe(0)
    // 另一条草稿：页面上同一条已经记给别人了，不再记
    expect(await watchSentOnce([{ ...target, key: 'w:other', job: 'other' }], deps, done)).toBe(0)
  })

  it('认最近一条：读这个帖子的评论，挑这个号在草稿之后发的、回对了那一条的最新一条', async () => {
    const listing = (children: unknown[]) => ({ kind: 'Listing', data: { children } })
    const c = (id: string, author: string, created: number, parent = 't3_abc') => ({
      kind: 't1',
      data: {
        name: `t1_${id}`,
        author,
        body: `body ${id}`,
        created_utc: created,
        parent_id: parent,
        permalink: `/r/ivraxr/comments/abc/x/${id}/`,
      },
    })
    const since = Date.parse('2026-10-22T08:00:00Z')
    const t: WatchTarget = { ...target, kind: 'reply', parent: 't1_c1', since_ms: since }
    const body = JSON.stringify([
      listing([]),
      listing([
        c('old', 'ivra_official', since / 1000 - 3600, 't1_c1'),
        c('mine', 'ivra_official', since / 1000 + 60, 't1_c1'),
        c('wrongparent', 'ivra_official', since / 1000 + 120),
        c('other', 'bob', since / 1000 + 200, 't1_c1'),
      ]),
    ])
    const urls: string[] = []
    const got = await latestSent(t, {
      me: 'u/ivra_official',
      read: async (url) => {
        urls.push(url)
        return { status: 200, url, content_type: 'application/json', body }
      },
    })
    expect(got.ok && got.hit.fullname).toBe('t1_mine')
    // 只读那一页（白名单里的地址）
    expect(urls[0]).toMatch(/^https:\/\/old\.reddit\.com\/comments\/abc\/\.json\?/u)
    const none = await latestSent(t, { me: undefined, read: async () => ({}) as never })
    expect(none.ok).toBe(false)
  })
})

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
})
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)
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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('WP467 侧边栏：填入 / 复制 / 我发了，帮我记一下', () => {
  it('按钮叫「填入」「复制」；复制后说自己粘贴也照样记；贴链接 / 认最近一条发给后台', async () => {
    const sent: ExtensionMessage[] = []
    const send = async (m: ExtensionMessage): Promise<ExtensionResponse | undefined> => {
      sent.push(m)
      if (m.type === 'panel-state')
        return { type: 'panel-state', state: { kind: 'ok', snapshot: snap(), reddit_here: true } }
      if (m.type === 'panel-sent' && m.how === 'latest')
        return {
          type: 'panel-act',
          ok: false,
          message: '这个帖子里没找到 u/ivra_official 新发的那一条',
        }
      if (m.type.startsWith('panel-')) return { type: 'panel-act', ok: true }
      return { type: 'ack' }
    }
    await act(async () => {
      root.render(
        <SidePanel
          send={send}
          refreshMs={60_000}
          windowId={async () => 7}
          copy={async () => true}
          version="x"
        />,
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(q('ws-desk-open')?.textContent).toBe('填入')
    expect(q('ws-desk-copy')?.textContent).toBe('复制')
    await click(q('ws-desk-copy'))
    expect(host.textContent).toContain('自己粘贴发出去，插件照样记')
    await click(q('ws-sent-open'))
    await setValue(q('ws-sent-link'), 'https://www.reddit.com/r/ivraxr/comments/abc/comment/new1/')
    await click(q('ws-sent-save'))
    expect(sent.find((m) => m.type === 'panel-sent')).toEqual({
      type: 'panel-sent',
      card: { id: 'ap_1', version: 3 },
      how: 'link',
      link: 'https://www.reddit.com/r/ivraxr/comments/abc/comment/new1/',
    })
    await click(q('ws-sent-latest'))
    expect(host.textContent).toContain('没找到 u/ivra_official 新发的那一条')
  })
})

/**
 * WP329：插件这一侧的 Reddit 写（假 old.reddit 标签页 + 假本机服务，不联网、不碰真站）。
 *
 * 守的是：插件只填草稿、不点发送；人点了、页面上出现新的那一条才回「做完」并带回编号与链接；
 * 发新帖时页面会自己换（脚本被扔掉）也认得出来；连上 Reddit（给了站点权限）才去问 Reddit 的活。
 */
import {
  buildRedditJob,
  REDDIT_WRITE_SELECTORS,
  REDDIT_WRITE_SELECTORS_NEW,
} from '@agentsws/browser-action'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { AdsDomRequest, BannerState } from '../src/lib/ads/dom-messages'
import { handleDomRequest } from '../src/lib/ads/dom-messages'
import { executeJob } from '../src/lib/ads/executor'
import { connectedPlatforms, type PermissionsLike } from '../src/lib/ads/permissions'
import { pollAdsOnce } from '../src/lib/ads/poller'
import type { TabDriver } from '../src/lib/ads/tab-page'
import { memoryStore, SETTINGS_KEY } from '../src/lib/storage'
import { fakeLocal } from './ads-fakes'

const NOW = '2026-10-14T09:00:00.000Z'
const ORIGIN = 'https://old.reddit.com'

const comment = (id: string, text: string) =>
  `<div class="thing comment" id="thing_t1_${id}" data-fullname="t1_${id}" data-permalink="/r/ivraxr/comments/abc/s/${id}/">
    <div class="entry"><div class="usertext-body"><p>${text}</p></div>
    <ul class="buttons"><li class="reply-button"><a href="#">reply</a></li></ul></div>
    <div class="child"></div></div>`

/** 假的 old.reddit 标签页（「人」点发送由测试调 {@link send}）。 */
class FakeRedditTab {
  doc: Document = new JSDOM('').window.document
  url = 'about:blank'
  status: 'loading' | 'complete' = 'complete'
  injected = 0
  banners: (BannerState | null)[] = []
  clicks: string[] = []
  /** 下一次 dom 调用抛错（页面在换，脚本被扔掉了）。 */
  gone = false
  posted: { id: string; text: string }[] = []

  load(url: string): void {
    this.url = url
    const u = new URL(url)
    let body = ''
    if (/\/submit\/?$/u.test(u.pathname))
      body = `<div id="title-field"><textarea name="title"></textarea></div><div id="text-field"><textarea name="text"></textarea></div><button name="submit">submit</button>`
    else if (u.pathname.startsWith('/r/ivraxr/comments/new'))
      body = `<div id="siteTable"><div class="thing link" data-fullname="t3_new1" data-permalink="${u.pathname}"><div class="entry"><a class="title">${this.posted[0]?.text ?? ''}</a></div></div></div>`
    else
      body = `<div class="commentarea"><form class="usertext"><textarea name="text"></textarea></form><div class="sitetable">${comment('c1', 'Mine fogs up')}</div></div>`
    this.doc = new JSDOM(
      `<!doctype html><html><head><title>reddit</title></head><body>${body}</body></html>`,
      {
        url,
      },
    ).window.document
    this.doc.querySelector('#thing_t1_c1 .reply-button a')?.addEventListener('click', () => {
      this.doc
        .querySelector('#thing_t1_c1 > .child')
        ?.insertAdjacentHTML(
          'afterbegin',
          '<form class="usertext"><textarea name="text"></textarea><button class="save">save</button></form>',
        )
    })
  }

  /** 人点发送。 */
  send(): void {
    const title = this.doc.querySelector<HTMLTextAreaElement>('#title-field textarea')
    if (title !== null) {
      this.posted.push({ id: 'new1', text: title.value })
      this.gone = true
      this.status = 'loading'
      this.load(`${ORIGIN}/r/ivraxr/comments/new1/t/`)
      return
    }
    const box = this.doc.querySelector<HTMLTextAreaElement>('#thing_t1_c1 > .child > form textarea')
    if (box === null) return
    this.doc
      .querySelector('#thing_t1_c1 > .child')
      ?.insertAdjacentHTML('beforeend', `<div class="sitetable">${comment('r1', box.value)}</div>`)
  }

  driver(onSleep: () => void): TabDriver {
    return {
      facts: async () => ({ url: this.url, status: this.status, active: true, windowId: 1 }),
      navigate: async (url) => this.load(url),
      activate: async () => {},
      inject: async () => {
        this.injected += 1
      },
      dom: async (req: AdsDomRequest) => {
        if (this.gone) {
          this.gone = false
          this.status = 'complete'
          throw new Error('Could not establish connection. Receiving end does not exist.')
        }
        if (req.op === 'click') this.clicks.push(req.selector)
        return handleDomRequest(this.doc, this.url, req)
      },
      banner: async (s) => {
        this.banners.push(s)
      },
      capture: async () => 'data:image/png;base64,iVBORw0KGgo=',
      downloadsAllowed: async () => false,
      watchDownload: async () => ({ ok: false, why: 'no' }),
      sleep: async () => onSleep(),
    }
  }
}

const job = (action: Parameters<typeof buildRedditJob>[0]['action']) =>
  buildRedditJob({
    id: 'rdw_1',
    workspace_id: 'ws',
    account_id: 'ivra_official',
    action,
    approval_id: 'ap_1',
    approval_level: 'L1',
    created_at: NOW,
  })

async function run(tab: FakeRedditTab, j: ReturnType<typeof job>, sendAfterSleeps: number) {
  const local = fakeLocal({})
  let sleeps = 0
  let filled = false
  const driver = tab.driver(() => {
    if (!filled) return
    sleeps += 1
    if (sleeps === sendAfterSleeps) tab.send()
  })
  const wrapped: TabDriver = {
    ...driver,
    dom: async (req) => {
      if (req.op === 'fill') filled = true
      return driver.dom(req)
    },
  }
  const result = await executeJob(j, {
    client: { port: 4399, token: 'ext_t', fetch: local.fetch },
    driver: wrapped,
    control: { stop: false },
    now: () => NOW,
    sleep: async () => wrapped.sleep(0),
    gapMs: 0,
  })
  return { result, local }
}

describe('WP329 插件填草稿、人点发送', () => {
  it('楼中楼：点 reply、填草稿，人点了发送 → 回「做完」+ 新评论的编号与链接；插件没点发送', async () => {
    const tab = new FakeRedditTab()
    const { result, local } = await run(
      tab,
      job({
        write: { kind: 'reply', parent: 't1_c1', permalink: '/r/ivraxr/comments/abc/s/c1/' },
        text: 'Hi Alice, the anti-fog insert helps.',
      }),
      3,
    )
    expect(result.outcome).toBe('done')
    expect(result.reads).toMatchObject({
      fullname: 't1_r1',
      permalink: '/r/ivraxr/comments/abc/s/r1/',
    })
    // WP445：一律新版 www.reddit.com；这一页是旧版样子（品牌号设了旧版界面）→ 新版找不到、按旧版兜底
    expect(tab.url.startsWith('https://www.reddit.com/')).toBe(true)
    expect(tab.clicks).toEqual([
      `${REDDIT_WRITE_SELECTORS_NEW.replyLink('t1_c1')} || ${REDDIT_WRITE_SELECTORS.replyLink('t1_c1')}`,
    ])
    expect(result.reads.fill_missed).toBeUndefined()
    // 横条上说了「填好了，等你点发送」
    expect(tab.banners.some((b) => b?.label === '填好了，等你点发送')).toBe(true)
    const sent = local.calls.find((c) => c.path.endsWith('/result'))
    expect(sent?.body).toMatchObject({ outcome: 'done' })
  })

  it('发新帖：人点 submit 后页面换了（脚本被扔掉）→ 放回脚本、认出新帖', async () => {
    const tab = new FakeRedditTab()
    const { result } = await run(
      tab,
      job({ write: { kind: 'submit', subreddit: 'ivraxr', title: 'Weekly Q&A' }, text: 'Ask us.' }),
      2,
    )
    expect(result.outcome).toBe('done')
    expect(result.reads.fill_missed).toBeUndefined()
    expect(result.reads.fullname).toBe('t3_new1')
    expect(tab.injected).toBeGreaterThan(1)
  })
})

describe('WP329 连接 Reddit', () => {
  const REDDIT = ['https://old.reddit.com/*', 'https://www.reddit.com/*']
  const perms = (granted: string[]): PermissionsLike => ({
    contains: async (p) => (p.origins ?? []).every((o) => granted.includes(o)),
    request: async () => true,
    remove: async () => true,
  })

  it('给了 Reddit 的站点权限才算连上；领活时报 reddit', async () => {
    expect(await connectedPlatforms(perms([]))).toEqual([])
    expect(await connectedPlatforms(perms(REDDIT))).toEqual(['reddit'])
    const seen: string[] = []
    const local = fakeLocal({})
    const fetchSpy = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(input))
      return local.fetch(input, init)
    }) as typeof globalThis.fetch
    const out = await pollAdsOnce({
      store: memoryStore({ [SETTINGS_KEY]: { port: 4399, token: 'ext_t' } }),
      perms: perms(REDDIT),
      fetch: fetchSpy,
      openTab: async () => ({ why: 'x' }),
      control: { stop: false },
      now: () => NOW,
      sleep: async () => {},
      waitSeconds: 0,
    })
    expect(out).toBe('idle')
    expect(seen[0]).toContain('platforms=reddit')
  })
})

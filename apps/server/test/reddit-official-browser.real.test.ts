/**
 * WP249：Reddit 官方号浏览器通道 × **本机已装的 Chrome / Edge** × 本地假 old.reddit
 * （不访问 reddit.com、不登录任何网站）。
 *
 * 默认跳过（CI 与并行代理不起浏览器）；要跑：
 *   AGENTSWS_REAL_CHROME=1 npx vitest run apps/server/test/reddit-official-browser.real.test.ts
 * 用的配置目录是临时建的，跑完只删它自己。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBrowser } from '../src/readonly-browser/find-browser.js'
import {
  createRedditOfficialBrowser,
  type RedditOfficialBrowser,
} from '../src/reddit-official-browser/index.js'
import { type FakeOldRedditSite, startFakeOldReddit } from './fake-old-reddit-site.js'

const RUN = process.env.AGENTSWS_REAL_CHROME === '1' && findBrowser().ok

const leftovers = (dir: string): string => {
  if (process.platform === 'win32') return ''
  try {
    return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

describe.skipIf(!RUN)('官方号浏览器 × 本机 Chrome × 本地假 old.reddit', () => {
  let site: FakeOldRedditSite
  let root: string
  let rob: RedditOfficialBrowser
  const writes = () =>
    site.seen.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`)

  beforeAll(async () => {
    site = await startFakeOldReddit()
    site.queues.modqueue = [
      {
        kind: 't3',
        id: 'spam1',
        title: 'Cheap glasses, DM me on telegram',
        body: 'wholesale https://bit.ly/x',
        author: 'spammer1',
        reports: ['No spam or self-promotion'],
      },
      {
        kind: 't3',
        id: 'held1',
        title: 'My review',
        body: 'Sharp display.',
        author: 'bob',
        reports: [],
      },
    ]
    site.queues.unmoderated = [
      {
        kind: 't3',
        id: 'new1',
        title: 'Hello',
        body: 'Just got mine',
        author: 'carol',
        reports: [],
      },
    ]
    root = mkdtempSync(join(tmpdir(), 'agentsws-wp249-'))
    rob = createRedditOfficialBrowser({
      dir: root,
      origin: site.origin,
      allowedHosts: () => ['127.0.0.1'],
      nowMs: () => Date.now(),
      limits: () => ({
        read_interval_seconds: 0,
        reads_per_day: 100,
        write_interval_seconds: 0,
        writes_per_day: 100,
      }),
      loginHeadless: true,
      idleMs: 60_000,
    })
  }, 60_000)

  afterAll(async () => {
    await rob?.close()
    await site?.close()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  })

  it('登录官方号 → 体检看到登录名（我们没碰密码，只看右上角）', async () => {
    expect(rob.status().state).toBe('unknown')
    await rob.openLogin()
    const s = await rob.checkLogin()
    expect(s).toMatchObject({ state: 'logged_in', username: 'inmo_official' })
  }, 60_000)

  it('读：两个队列（.json）+ 版规；读的时候一个写请求都没放出去', async () => {
    const mq = await rob.port.readModQueue('inmoxr', 'modqueue', 50)
    expect(mq.ok && mq.data.map((e) => e.id)).toEqual(['t3_spam1', 't3_held1'])
    const un = await rob.port.readModQueue('inmoxr', 'unmoderated', 50)
    expect(un.ok && un.data.map((e) => e.id)).toEqual(['t3_new1'])
    const rules = await rob.port.readRules('inmoxr')
    expect(rules).toEqual({ ok: true, data: ['No spam or self-promotion', 'Be civil'] })
    expect(writes()).toEqual([])
  }, 60_000)

  it('批准：真点了页面上的 approve，只发出 /api/approve；页面里偷偷点赞的脚本被掐了', async () => {
    const r = await rob.port.run({
      kind: 'approve',
      sub: 'inmoxr',
      fullname: 't3_held1',
      queue: 'modqueue',
    })
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'ok', fullname: 't3_held1' })
    expect(writes()).toEqual(['POST /api/approve'])
    expect(site.queues.modqueue.map((t) => t.id)).toEqual(['spam1'])
  }, 60_000)

  it('移除 + 公开留一句版规理由；封禁；发帖并置顶；回帖——每次只发卡上那个动作要的写请求', async () => {
    const before = writes().length
    const ok = async (w: Parameters<RedditOfficialBrowser['port']['run']>[0]) => {
      const r = await rob.port.run(w)
      expect(r, `${w.kind}: ${JSON.stringify(r)}`).toMatchObject({ status: 'ok' })
      return r
    }
    await ok({
      kind: 'remove',
      sub: 'inmoxr',
      fullname: 't3_spam1',
      queue: 'modqueue',
      removal_message: 'Removed: rule 1',
    })
    expect(site.comments.spam1).toEqual(['Removed: rule 1'])
    await ok({ kind: 'ban', sub: 'inmoxr', username: 'spammer1', days: 7 })
    expect(site.banned).toEqual(['spammer1'])
    const made = await ok({
      kind: 'submit',
      sub: 'inmoxr',
      title: 'Weekend AMA',
      text: 'Ask us',
      sticky: true,
    })
    expect(made).toMatchObject({ fullname: 't3_n1' })
    expect(site.posts).toEqual([{ id: 'n1', title: 'Weekend AMA', text: 'Ask us', sticky: true }])
    await ok({ kind: 'reply', post_fullname: 't3_n1', text: 'Thanks all' })
    expect(writes().slice(before)).toEqual([
      'POST /api/remove',
      'POST /api/comment',
      'POST /api/friend',
      'POST /api/submit',
      'POST /api/set_subreddit_sticky',
      'POST /api/comment',
    ])
    // 所有写请求都带着官方号的登录态（同一个独立目录），点赞一次都没到站上
    expect(site.seen.filter((r) => r.method === 'POST').every((r) => r.cookie)).toBe(true)
    expect(writes()).not.toContain('POST /api/vote')
  }, 120_000)

  it('弹验证码：照实停下（要人去窗口里处理），通道停一阵，不重试', async () => {
    site.queues.unmoderated = [
      { kind: 't3', id: 'new2', title: 'Hi', body: 'x', author: 'dan', reports: [] },
    ]
    site.captchaNext = true
    const before = writes().length
    const r = await rob.port.run({
      kind: 'approve',
      sub: 'inmoxr',
      fullname: 't3_new2',
      queue: 'unmoderated',
    })
    expect(r.status).toBe('handover')
    expect(writes().length).toBe(before)
    expect(rob.status().state).toBe('blocked')
    expect(rob.port.ready()).toBe(false)
  }, 60_000)

  it('关掉之后不留浏览器进程', async () => {
    await rob.close()
    await new Promise((r) => setTimeout(r, 1500))
    expect(leftovers(root)).toBe('')
  }, 30_000)
})

// @vitest-environment jsdom
/**
 * WP329：Reddit 的三种写在本地假 old.reddit 上走一遍（不联网、不碰真站）。
 * 守的是 docs/102 §2.2 / §2.3：插件只填草稿、**从不点发送**；人点了、页面上出现新的那一条才算发出去，
 * 读回编号与链接；没点 / 被拦 / 没登录 / 帖子锁了 就停下照实报。
 */
import { describe, expect, it } from 'vitest'
import {
  type ActionResult,
  buildRedditJob,
  checkPlanSteps,
  domFindPosted,
  normalizeZoneSettings,
  REDDIT_WRITE_SELECTORS,
  RedditPlanError,
  type RedditWriteAction,
  type RunHooks,
  redditCommentsPath,
  redditWritePlan,
  runAction,
  sentSnippet,
  validateJob,
} from '../src/index.js'
import { FakeReddit, type FakeRedditState, fakeRedditState } from './fake-reddit.js'

const PERMALINK = '/r/ivraxr/comments/abc/slug/c1/'
const DRAFT =
  'Hi Alice, IVRA here — the **Air3** has an anti-fog insert in the box.\n\nMore: [FAQ](https://ivra.example/faq)'

const reply: RedditWriteAction = {
  write: { kind: 'reply', parent: 't1_c1', permalink: PERMALINK },
  text: DRAFT,
}
const comment: RedditWriteAction = {
  write: { kind: 'comment', post: 't3_abc', permalink: '/r/ivraxr/comments/abc/slug/' },
  text: 'Thanks for asking! It works with most frames.',
}
const submit: RedditWriteAction = {
  write: { kind: 'submit', subreddit: 'r/ivraxr', title: 'Weekly Q&A thread' },
  text: 'Ask anything about the Air3 here.',
}

const job = (action: RedditWriteAction, id = 'job_1') =>
  buildRedditJob({
    id,
    workspace_id: 'ws',
    account_id: 'ivra_official',
    action,
    approval_id: `ap_${id}`,
    approval_level: 'L1',
    created_at: '2026-10-14T00:00:00.000Z',
    // WP445 起默认新版 www.reddit.com；这一份钉的是旧版页面那一套（兜底用的就是它）
    origin: 'https://old.reddit.com',
  })

/** 「人」在第 `sendAt` 次等的时候点发送（不给就一直不点）。 */
function run(
  page: FakeReddit,
  action: RedditWriteAction,
  o: { sendAt?: number; stopAt?: number; timeout?: number } = {},
) {
  let sleeps = 0
  let inAwait = false
  const progress: string[] = []
  const hooks: RunHooks = {
    progress: async (p) => {
      progress.push(p.label)
      inAwait = p.label === '填好了，等你点发送'
      return { stop: false }
    },
    stopped: () => o.stopAt !== undefined && sleeps >= o.stopAt,
    confirm: async () => 'yes',
    evidence: async () => {},
    downloaded: async () => {},
    sleep: async () => {
      if (inAwait) sleeps += 1
      if (inAwait && o.sendAt !== undefined && sleeps === o.sendAt) page.humanSend()
    },
    gapMs: 0,
    sendPollMs: 0,
    sendTimeoutMs: o.timeout ?? 0,
  }
  // 超时按「看了几眼」算：pollMs = 0 时 waited 不涨，用 timeout = 0 表示「看一眼就算超时」
  return runAction(job(action), page, {
    ...hooks,
    sendTimeoutMs: o.timeout ?? (o.sendAt === undefined ? 0 : 1),
  })
}

describe('WP329 Reddit 写的计划', () => {
  it('三种写都没有发送 / 保存按钮在白名单里（插件从不点发送）', () => {
    for (const a of [reply, comment, submit]) {
      const plan = redditWritePlan(a)
      expect(plan.platform).toBe('reddit')
      expect(plan.pace).toBe('write')
      for (const sel of plan.allow.click) expect(sel).not.toMatch(/save|submit/iu)
      expect(plan.steps.some((s) => s.op === 'click' && /save|submit/iu.test(s.selector))).toBe(
        false,
      )
      expect(plan.steps.at(-1)?.op).toBe('await_sent')
      expect(checkPlanSteps(plan.steps, plan.allow, plan.kind).ok).toBe(true)
    }
  })

  it('填的字只能是卡上那一段：改过的步骤过不了白名单', () => {
    const plan = redditWritePlan(reply)
    const tampered = plan.steps.map((s) => (s.op === 'fill' ? { ...s, value: 'buy now' } : s))
    const v = checkPlanSteps(tampered, plan.allow, plan.kind)
    expect(v.ok).toBe(false)
  })

  it('楼中楼要那条评论的链接；编号 / 版块 / 正文不对就不进队', () => {
    expect(() =>
      redditWritePlan({ ...reply, write: { kind: 'reply', parent: 't1_c1', permalink: '/u/x' } }),
    ).toThrow(RedditPlanError)
    expect(() => redditWritePlan({ ...reply, text: '  ' })).toThrow(RedditPlanError)
    expect(() =>
      redditWritePlan({ ...submit, write: { kind: 'submit', subreddit: 'a b', title: 'x' } }),
    ).toThrow(RedditPlanError)
    expect(
      redditCommentsPath('https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/?context=3'),
    ).toBe(PERMALINK)
    expect(
      redditWritePlan({ ...comment, write: { kind: 'comment', post: 'abc' } }).steps[0],
    ).toEqual({
      op: 'goto',
      // WP445：一律新版 www.reddit.com；WP467：带上帖子 id（已经开着这个帖子就地填）
      url: 'https://www.reddit.com/comments/abc/',
      post: 'abc',
    })
  })

  it('写操作要审批编号才进队', () => {
    const j = job(reply)
    expect(validateJob(j, { zones: normalizeZoneSettings(undefined) }).ok).toBe(true)
    const { approval_id: _drop, ...noApproval } = j
    expect(validateJob(noApproval, { zones: normalizeZoneSettings(undefined) }).ok).toBe(false)
  })

  it('草稿 → 认「发出去那一条」的那一截：Markdown 渲染前后对得上', () => {
    expect(sentSnippet(DRAFT)).toBe('hialiceivraheretheair3hasanantifoginsertinthebox')
    const doc = new DOMParser().parseFromString(
      `<div class="thing" data-fullname="t1_z" data-permalink="/p/"><div class="entry"><div class="usertext-body"><p>Hi Alice, IVRA here — the <strong>Air3</strong> has an anti-fog insert in the box.</p></div></div></div>`,
      'text/html',
    )
    expect(domFindPosted(doc, '.thing', REDDIT_WRITE_SELECTORS.commentBody, DRAFT)).toMatchObject([
      { fullname: 't1_z', permalink: '/p/' },
    ])
  })
})

describe('WP329 Reddit 写在假 old.reddit 上', () => {
  const fresh = (patch: Partial<FakeRedditState> = {}) => new FakeReddit(fakeRedditState(patch))

  it('楼中楼：点 reply、填草稿、人点发送 → 读回新评论的编号与链接', async () => {
    const page = fresh()
    const r: ActionResult = await run(page, reply, { sendAt: 2 })
    expect(r.outcome).toBe('done')
    expect(r.reads.fullname).toBe('t1_new1')
    expect(r.reads.permalink).toBe('/r/ivraxr/comments/abc/slug/new1/')
    expect(page.visited[0]).toBe(`https://old.reddit.com${PERMALINK}`)
    expect(page.clicks).toEqual([REDDIT_WRITE_SELECTORS.replyLink('t1_c1')])
    expect(page.state.sent[0]?.parent).toBe('t1_c1')
  })

  it('人填完马上就点了发送（还没开始等）：照样认得出，不当成老的', async () => {
    const page = fresh()
    const r = await runAction(job(reply), page, {
      progress: async (p) => {
        if (p.label === '填好了，等你点发送') page.humanSend()
        return { stop: false }
      },
      stopped: () => false,
      confirm: async () => 'yes',
      evidence: async () => {},
      downloaded: async () => {},
      sleep: async () => {},
      gapMs: 0,
      sendPollMs: 0,
      sendTimeoutMs: 1,
    })
    expect(r.outcome).toBe('done')
    expect(r.reads.fullname).toBe('t1_new1')
  })

  it('回帖子（顶层评论）', async () => {
    const page = fresh()
    const r = await run(page, comment, { sendAt: 1 })
    expect(r.outcome).toBe('done')
    expect(r.reads.fullname).toBe('t1_new1')
    expect(page.clicks).toEqual([])
  })

  it('发新帖：填标题和正文，人点 submit 落到新帖页 → 读回 t3 编号', async () => {
    const page = fresh()
    const r = await run(page, submit, { sendAt: 1 })
    expect(r.outcome).toBe('done')
    expect(r.reads.fullname).toBe('t3_new1')
    expect(r.reads.permalink).toBe('/r/ivraxr/comments/new1/title/')
  })

  it('人一直没点发送 → 停下交给人，不算发出去（不代点）', async () => {
    const page = fresh()
    const r = await run(page, reply)
    expect(r.outcome).toBe('handover')
    expect(r.message).toContain('不算发出')
    expect(page.state.sent).toEqual([])
  })

  it('页面上早就有一条一样的回复：不把老的认成刚发的', async () => {
    const page = fresh({ duplicate: DRAFT })
    const r = await run(page, reply)
    expect(r.outcome).toBe('handover')
    const ok = await run(fresh({ duplicate: DRAFT }), reply, { sendAt: 1 })
    expect(ok.reads.fullname).toBe('t1_new1')
  })

  it('点了发送但 Reddit 说太快了 → 停下照实说', async () => {
    const page = fresh({ rateLimited: true })
    const r = await run(page, comment, { sendAt: 1 })
    expect(r.outcome).toBe('handover')
    expect(r.message).toMatch(/频繁|受限/u)
  })

  it('没登录 → 打开页面就停，提示在这个标签页里登录', async () => {
    const r = await run(fresh({ loggedIn: false }), reply, { sendAt: 1 })
    expect(r.outcome).toBe('handover')
    expect(r.message).toContain('Reddit没登录')
    expect(r.step).toBe(1)
  })

  it('帖子锁了（没有评论框）→ 等不到框就停', async () => {
    const r = await run(fresh({ locked: true }), comment, { sendAt: 1 })
    expect(r.outcome).toBe('handover')
    expect(r.step).toBe(2)
  })

  it('等发送时点了停止 → 停，草稿留在页面上', async () => {
    const r = await run(fresh(), reply, { stopAt: 1, timeout: 60_000 })
    expect(r.outcome).toBe('stopped')
    expect(r.message).toContain('没发')
  })
})

describe('WP329（决策 764）：插件只读版规', () => {
  it('sub_rules：白名单里、一页、解析成一条一行', async () => {
    const { checkRedditReadRequest, redditReadUrl, redditRulesOf, runRedditRead } = await import(
      '../src/index.js'
    )
    const req = {
      key: 'rules:ivraxr',
      kind: 'sub_rules' as const,
      subreddit: 'ivraxr',
      max_pages: 1,
    }
    expect(checkRedditReadRequest(req)).toBeUndefined()
    expect(redditReadUrl(req)).toBe('https://old.reddit.com/r/ivraxr/about/rules.json?raw_json=1')
    expect(checkRedditReadRequest({ ...req, subreddit: '../x' })).toBe('版块名不对。')
    expect(
      redditRulesOf({
        rules: [{ short_name: 'Be civil', description: 'Be civil', violation_reason: 'Rude' }],
      }),
    ).toEqual(['Be civil：Rude'])
    const res = await runRedditRead(
      { id: 'j', workspace_id: 'ws', reads: [req], title: 't', created_at: 'x' },
      {
        fetch: async (url) => ({
          status: 200,
          url,
          content_type: 'application/json',
          body: url.includes('/api/me.json')
            ? JSON.stringify({ kind: 't2', data: { name: 'ivra_official' } })
            : JSON.stringify({ rules: [{ short_name: 'No links' }] }),
        }),
        sleep: async () => {},
        stopped: () => false,
        gapMs: 0,
      },
    )
    expect(res.parts[0]).toMatchObject({ key: 'rules:ivraxr', ok: true, rules: ['No links'] })
  })
})

// @vitest-environment jsdom
/**
 * WP432（Luoye 10-20 反馈 9，最急）：Reddit 发帖回帖改成插件半自动——
 *
 * 1. **批了不自动开页面**：Reddit 的写进队就是「等你在插件里打开」，插件的定时领活永远领不到，
 *    只有人在侧边栏点「打开这一条」（{@link ActionQueue.open}）才交出去；
 * 2. **发送按钮不在任何白名单**（新版、旧版两套都钉）；
 * 3. **默认新版 www.reddit.com**：shreddit 页面上点 Reply、往富文本框里填、描一圈；人改了字再发也认得出，
 *    读回真发出去的字；认不出页面（改版了）就停在「等你粘贴」、不乱点，人自己粘贴发出去照样读回。
 */
import { describe, expect, it } from 'vitest'
import {
  ActionQueue,
  buildRedditJob,
  checkPlanSteps,
  checkRedditReadRequest,
  FILL_HIGHLIGHT,
  HELD_TTL_MS,
  needsHumanOpen,
  Pace,
  REDDIT_WRITE_SELECTORS_NEW,
  type RedditWriteAction,
  type RunHooks,
  redditReadUrl,
  redditSiteOf,
  redditWritePlan,
  resolveOne,
  runAction,
  SOFT_MISS_LABEL,
} from '../src/index.js'
import { FakeShreddit, fakeShredditState } from './fake-shreddit.js'

const NEW = 'https://www.reddit.com'
const OLD = 'https://old.reddit.com'
const DRAFT = 'Hi Alice, the Air3 fits over most prescription frames.'

const reply: RedditWriteAction = {
  write: { kind: 'reply', parent: 't1_c1', permalink: '/r/ivraxr/comments/abc/slug/c1/' },
  text: DRAFT,
}
const comment: RedditWriteAction = {
  write: { kind: 'comment', post: 't3_abc', permalink: '/r/ivraxr/comments/abc/slug/' },
  text: 'Thanks for asking! It works with most frames.',
}
const submit: RedditWriteAction = {
  write: { kind: 'submit', subreddit: 'ivraxr', title: 'Weekly Q&A thread' },
  text: 'Ask anything about the Air3 here.',
}

const job = (action: RedditWriteAction, origin = NEW, id = 'rdw_1') =>
  buildRedditJob({
    id,
    workspace_id: 'ws',
    account_id: 'ivra_official',
    action,
    approval_id: `ap_${id}`,
    approval_level: 'L1',
    created_at: '2026-10-21T00:00:00.000Z',
    origin,
    author: 'ivra_official',
  })

const adsJob = {
  ...job(reply),
  id: 'ads_1',
  account: { platform: 'google_ads' as const, id: '123' },
  plan: { ...job(reply).plan, platform: 'google_ads' as const, pace: 'read' as const },
}

describe('WP432 批了不自动开页面', () => {
  it('Reddit 的写进队就是「等你打开」：定时领活领不到，人点「打开这一条」才交出去', () => {
    const q = new ActionQueue({ pace: new Pace({ state: {} }) })
    const now = Date.parse('2026-10-21T00:00:00.000Z')
    const row = q.enqueue(job(reply), now)
    expect(row.held).toBe(true)
    expect(needsHumanOpen(row.job)).toBe(true)
    // 插件每分钟来领一次，一天也领不到
    for (let m = 0; m < 24 * 60; m += 1)
      expect(q.claim(['reddit'], now + m * 60_000)).toBeUndefined()
    // 人点了
    const opened = q.open(row.job.id, now + 1000)
    expect('why' in opened).toBe(false)
    expect(q.get(row.job.id)?.status).toBe('running')
    // 开过的不能再开一次
    expect(q.open(row.job.id, now + 2000)).toEqual({ why: '这一条已经打开了，在那个标签页里。' })
  })

  it('本机服务忘了标 hold、或者是升级前排着的老活：照样领不到（公共模块里的一道底）', () => {
    const q = new ActionQueue({
      pace: new Pace({ state: {} }),
      // 升级前落盘的那一行没有 held
      state: [{ job: job(reply), status: 'queued', enqueued_at_ms: 0 }],
    })
    expect(q.claim(['reddit', 'google_ads'], 1000)).toBeUndefined()
    expect('why' in q.open('rdw_1', 1000)).toBe(false)
  })

  it('广告的活照旧由定时领活领走（不受影响）', () => {
    const q = new ActionQueue({ pace: new Pace({ state: {} }) })
    q.enqueue(adsJob, 0)
    expect(q.claim(['google_ads'], 1000)?.job.id).toBe('ads_1')
  })

  it('等你打开的 7 天没打开才作废（不是 24 小时），作废也不开页面', () => {
    const q = new ActionQueue({ pace: new Pace({ state: {} }) })
    q.enqueue(job(reply), 0)
    expect(q.sweep(25 * 60 * 60 * 1000)).toEqual([])
    const gone = q.sweep(HELD_TTL_MS)
    expect(gone.map((r) => r.status)).toEqual(['expired'])
    expect(gone[0]?.result?.message).toContain('7 天没打开')
  })
})

describe('WP432 新版 Reddit 的计划', () => {
  it('默认认 www.reddit.com 为新版；old.reddit 与本地假页面按旧版', () => {
    expect(redditSiteOf(NEW)).toBe('new')
    expect(redditSiteOf(OLD)).toBe('old')
    expect(redditSiteOf('http://127.0.0.1:9')).toBe('old')
  })

  it('新版旧版两套、三种写：发送 / Comment / Post 按钮都不在任何白名单里', () => {
    for (const origin of [NEW, OLD])
      for (const a of [reply, comment, submit]) {
        const plan = redditWritePlan(a, origin)
        for (const sel of plan.allow.click)
          expect(sel).not.toMatch(/save|submit|post|comment"\]$/iu)
        expect(
          plan.steps.some(
            (s) => s.op === 'click' && /save|submit|button\[type|Comment|Post/u.test(s.selector),
          ),
        ).toBe(false)
        expect(plan.steps.at(-1)?.op).toBe('await_sent')
        expect(checkPlanSteps(plan.steps, plan.allow, plan.kind).ok).toBe(true)
      }
  })

  it('新版：等框 / 点 Reply / 填字都是软步骤；打开页面不是（被拦照样停）', () => {
    const plan = redditWritePlan(reply, NEW)
    expect(plan.steps[0]).toEqual({
      op: 'goto',
      url: `${NEW}/r/ivraxr/comments/abc/slug/c1/`,
      // WP467：已经开着这个帖子、那条评论也在页面上 → 就地填
      post: 'abc',
      need: 'shreddit-comment[thingid="t1_c1"] || #thing_t1_c1',
    })
    // WP467：中间那一步「等回复框、等不到也往下走」是 optional（不算对不上）；别的照旧是软步骤
    for (const s of plan.steps.slice(1, -1))
      expect(('soft' in s && s.soft) || ('optional' in s && s.optional)).toBe(true)
    expect(plan.steps.find((s) => s.op === 'fill')).toMatchObject({ highlight: true })
  })
})

/** 「人」在第 `actAt` 次等的时候做那件事（改字 / 粘贴 / 点发送）。 */
function run(
  page: FakeShreddit,
  action: RedditWriteAction,
  act: () => void,
  o: { actAt?: number; author?: string } = {},
) {
  let sleeps = 0
  let inAwait = false
  const labels: string[] = []
  const hooks: RunHooks = {
    progress: async (p) => {
      labels.push(p.label)
      inAwait = p.label === '填好了，等你点发送' || p.label === SOFT_MISS_LABEL
      return { stop: false }
    },
    stopped: () => false,
    confirm: async () => 'yes',
    evidence: async () => {},
    downloaded: async () => {},
    sleep: async () => {
      if (inAwait) sleeps += 1
      if (inAwait && sleeps === (o.actAt ?? 1)) act()
    },
    gapMs: 0,
    waitTimeoutMs: 0,
    // 「等了多久」按看了几眼算（sleep 不真睡）：看 5 眼还没认出就算等不到
    sendPollMs: 1,
    sendTimeoutMs: 5,
  }
  return {
    labels,
    out: runAction(
      buildRedditJob({
        id: 'rdw_1',
        workspace_id: 'ws',
        account_id: 'ivra_official',
        action,
        approval_id: 'ap_1',
        created_at: '2026-10-21T00:00:00.000Z',
        origin: NEW,
        author: o.author ?? 'ivra_official',
      }),
      page,
      hooks,
    ),
  }
}

describe('WP432 在假新版 Reddit 上走一遍', () => {
  it('回评论：点 Reply、草稿填进富文本框并描一圈；人改了字再发 → 认得出、读回真发出去的字', async () => {
    const page = new FakeShreddit(fakeShredditState())
    const edited = 'Totally different wording from the human, sent by hand.'
    const { out } = run(page, reply, () => {
      const box = resolveOne(page.doc, REDDIT_WRITE_SELECTORS_NEW.replyBox('t1_c1')) as HTMLElement
      expect(box.textContent).toBe(DRAFT)
      expect(box.style.outline).toBe(FILL_HIGHLIGHT)
      page.humanType(edited)
      page.humanSend()
    })
    const r = await out
    expect(r.outcome).toBe('done')
    expect(r.reads.fullname).toBe('t1_new1')
    expect(r.reads.permalink).toBe('/r/ivraxr/comments/abc/comment/new1/')
    expect(r.reads.sent_text).toBe(edited)
    expect(r.reads.fill_missed).toBeUndefined()
    // WP445：新版找不到再按旧版兜底（` || ` 接着旧版那一条）
    expect(page.clicks[0]?.startsWith(REDDIT_WRITE_SELECTORS_NEW.replyLink('t1_c1'))).toBe(true)
    expect(page.clicks).toHaveLength(1)
  })

  it('页面改版认不出 Reply：不乱点、横条说「草稿在侧边栏里复制」，人自己粘贴发出去照样读回', async () => {
    const page = new FakeShreddit(fakeShredditState({ brokenReply: true }))
    const { out, labels } = run(page, reply, () => {
      page.humanType(DRAFT)
      page.humanSend()
    })
    const r = await out
    expect(r.outcome).toBe('done')
    expect(r.reads.fill_missed).toBe('1')
    expect(r.reads.fullname).toBe('t1_new1')
    expect(page.clicks).toEqual([])
    expect(page.fills).toEqual([])
    expect(labels).toContain(SOFT_MISS_LABEL)
  })

  it('不知道品牌号、人又改了字：认不出就不算发出（不猜）', async () => {
    const page = new FakeShreddit(fakeShredditState())
    const { out } = run(
      page,
      reply,
      () => {
        page.humanType('Something else entirely')
        page.humanSend()
      },
      { author: '' },
    )
    expect((await out).outcome).toBe('handover')
  })

  it('回帖子：点开「Join the conversation」、填好；人点发送 → 顶层新评论', async () => {
    const page = new FakeShreddit(fakeShredditState())
    const r = await run(page, comment, () => page.humanSend()).out
    expect(r.outcome).toBe('done')
    expect(page.state.sent[0]).toMatchObject({ parent: 't3_abc', text: comment.text })
  })

  it('发新帖：标题框在组件的 shadow root 里也填得进去；人点 Post 落到新帖页 → 读回 t3', async () => {
    const page = new FakeShreddit(fakeShredditState())
    const r = await run(page, submit, () => page.humanSend()).out
    expect(r.outcome).toBe('done')
    expect(r.reads.fullname).toBe('t3_new1')
    expect(page.state.sent[0]?.text).toBe('Weekly Q&A thread')
    expect(page.visited[0]).toBe(`${NEW}/r/ivraxr/submit/?type=TEXT&selftext=true`)
  })
})

describe('WP432 巡查顺手读回票数（只读）', () => {
  it('info：只读 /api/info.json、一次 1–25 条、编号要对、只读一页', () => {
    const ok = { key: 'scores', kind: 'info' as const, ids: ['t1_abc', 't3_xyz'], max_pages: 1 }
    expect(checkRedditReadRequest(ok)).toBeUndefined()
    expect(redditReadUrl(ok)).toContain('/api/info.json?')
    expect(redditReadUrl(ok)).toContain('id=t1_abc%2Ct3_xyz')
    expect(checkRedditReadRequest({ ...ok, ids: [] })).toBeDefined()
    expect(checkRedditReadRequest({ ...ok, ids: ['t4_dm'] })).toBeDefined()
    expect(
      checkRedditReadRequest({ ...ok, ids: Array.from({ length: 26 }, (_, i) => `t1_a${i}`) }),
    ).toBeDefined()
    expect(checkRedditReadRequest({ ...ok, max_pages: 2 })).toBeDefined()
  })
})

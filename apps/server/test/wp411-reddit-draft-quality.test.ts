/**
 * WP411（客户真机 10-18 #11）：起草质量——品牌号已经回过的不起草、口吻没定不起草（先出设置卡）、
 * 和品牌号已说过的话矛盾 / 没依据的技术细节 / 口吻不对 → 照着问题重写一次，还不行就标出来或换成「我去确认一下」。
 * 样本仿 客户真机那天的 20 张卡（召回、显示乱码、型号定位），品牌用假名 IVRA。替身模型、替身审批，不联网。
 */
import type {
  RedditPersona,
  RedditThreadContext,
  RedditWritePayload,
  RedditWriteTarget,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  conflictNote,
  type RedditDraftPromptInput,
  redditDraftMessages,
  redditDraftPrompt,
} from '../src/reddit-write/draft.js'
import { createRedditPersona } from '../src/reddit-write/persona.js'
import { createRedditWriteService } from '../src/reddit-write/service.js'
import { createResearchKit } from '../src/setup-research.js'

const ACTOR = {
  workspace_id: 'ws_1',
  person_id: 'p1',
  assignment_id: 'as1',
  role_id: 'social.reddit',
} as never

const TARGET: RedditWriteTarget = {
  kind: 'reply',
  subreddit: 'ivraxr',
  parent_fullname: 't1_c9',
  permalink: '/r/ivraxr/comments/post1/x/c9/',
  post_title: 'Air3 overheating?',
  parent_author: 'alice',
  parent_text: 'Is the recall real? Mine got hot.',
}
const PRIOR = 'It is true that some IVRA Air3 units were recalled due to overheating.'
const THREAD: RedditThreadContext = {
  comments: [{ fullname: 't1_c7', author: 'bob', text: 'mine too, got warm' }],
  ours: [
    {
      fullname: 't1_o1',
      author: 'ivra_official',
      text: PRIOR,
      created_at: '2026-10-12T03:00:00.000Z',
      parent_fullname: 't3_post1',
    },
  ],
  read: 'plugin',
}

/** 替身模型：按顺序回几稿；记下每次拿到的入参。 */
function make(drafts: string[], persona?: RedditPersona | null) {
  const calls: RedditDraftPromptInput[] = []
  const cards: RedditWritePayload[] = []
  const svc = createRedditWriteService({
    workspace_id: 'ws_1' as never,
    clock: { now: () => '2026-10-14T02:00:00.000Z' },
    approvals: {
      create: async (input: { payload: unknown }) => {
        cards.push(input.payload as RedditWritePayload)
        return { ...input, id: `ap_${cards.length}`, state: 'pending' } as never
      },
    } as never,
    emit: () => {},
    brand: () => 'IVRA',
    account: () => 'ivra_official',
    drafter: () => async (input) => {
      calls.push(input)
      const text = drafts[Math.min(calls.length - 1, drafts.length - 1)] ?? ''
      return { text }
    },
    facts: async () => [],
    ...(persona === undefined ? {} : { persona: () => persona ?? undefined }),
    record: () => undefined,
  })
  return { svc, calls, cards }
}

describe('不该起草的不起草', () => {
  it('品牌号已经直接回过这一条：不起草、说清楚哪天回的', async () => {
    const m = make(['x'], { stance: 'personal' })
    const thread: RedditThreadContext = {
      ...THREAD,
      ours: [{ ...THREAD.ours[0], parent_fullname: 't1_c9' } as never],
    }
    const r = await m.svc.draftAndStage(ACTOR, { target: TARGET, thread })
    expect(r).toEqual({
      staged: false,
      skipped: 'already_replied',
      message: expect.stringContaining('品牌号 10-12 已经回过这一条'),
    })
    expect(m.calls).toHaveLength(0)
  })
  it('口吻没定：一条都不起草（宿主先出设置卡）', async () => {
    const m = make(['x'], null)
    const r = await m.svc.draftAndStage(ACTOR, { target: TARGET, thread: THREAD })
    expect(r).toMatchObject({ staged: false, skipped: 'needs_persona' })
    expect(m.calls).toHaveLength(0)
  })
})

describe('起草：读整串、照口径、没依据不写、口吻照用', () => {
  it('提示里有整串、品牌号说过的话（不许矛盾）、口吻与自我介绍、「没依据就说我去确认一下」', () => {
    const p = redditDraftPrompt({
      target: TARGET,
      brand: 'IVRA',
      account: 'ivra_official',
      voice: '',
      facts: [],
      thread: THREAD,
      persona: { stance: 'personal', intro: 'I used to work at IVRA', avoid: ['DM me'] },
    })
    // 围栏里的外部文本做过 NFKC（全角冒号变半角）
    expect(p).toContain('bob:mine too, got warm')
    expect(p).toContain(`2026-10-12:${PRIOR}`)
    expect(p).toContain('不许和它矛盾')
    expect(p).toContain('口吻：个人')
    expect(p).toContain('「I used to work at IVRA」')
    expect(p).toContain('别说：DM me')
    expect(p).toContain('Let me check on that and get back to you')
  })

  it('WP471（决策 1549）：同一品牌两条——系统提示逐字相同；帖子串在用户消息后面，重写那次只往后加', () => {
    const base = {
      brand: 'IVRA',
      account: 'ivra_official',
      voice: '【品牌话术｜brand-voice】\nFriendly, short.',
      persona: { stance: 'personal', intro: 'I used to work at IVRA' } as RedditPersona,
    }
    const a = redditDraftMessages({ ...base, target: TARGET, facts: [], thread: THREAD })
    const b = redditDraftMessages({
      ...base,
      target: { ...TARGET, parent_text: 'Does it fog up?', post_title: 'Air3 fog' },
      facts: [{ id: 'fc_1', text: 'An anti-fog insert ships in the box.' }],
    })
    expect(b.system).toBe(a.system)
    expect(a.system).toContain('Friendly, short.')
    expect(a.system).toContain('口吻：个人')
    expect(a.system).toContain('规矩：')
    expect(a.user).not.toContain('规矩：')
    // 用户消息：品牌 / 版块在前，帖子与评论串在后
    expect(a.user.startsWith('你在帮「IVRA」')).toBe(true)
    expect(a.user.indexOf('知识库里查到的事实')).toBeLessThan(a.user.indexOf('Is the recall real'))
    // 重写那次：前面一整段原样，只在最后加「上一稿有这几处不行」
    const again = redditDraftMessages({
      ...base,
      target: TARGET,
      facts: [],
      thread: THREAD,
      fix: ['和品牌号说过的矛盾'],
    })
    expect(again.system).toBe(a.system)
    expect(again.user.startsWith(a.user)).toBe(true)
  })

  it('和品牌号说过的矛盾：照着问题重写一次；重写对了就不标', async () => {
    const m = make(
      [
        "I can't speak to recall claims, but the Air3 is solid.",
        'Yes — some Air3 units were recalled due to overheating, so check the serial on the box.',
      ],
      { stance: 'personal' },
    )
    const r = await m.svc.draftAndStage(ACTOR, { target: TARGET, thread: THREAD })
    expect(r.staged).toBe(true)
    expect(m.calls).toHaveLength(2)
    expect(m.calls[1]?.fix?.[0]).toContain('矛盾')
    expect(m.cards[0]?.body.text).toContain('were recalled')
    expect(m.cards[0]?.checks).toBeUndefined()
    // 卡上带着「你 10-12 已回：……」
    expect(m.cards[0]?.prior_replies?.[0]?.text).toBe(PRIOR)
  })

  it('重写还矛盾（决策 1199）：不出卡，回「和你 10-12 说的矛盾，要你看」并带原话与日期', async () => {
    const m = make(["I can't speak to recall claims, sorry."], { stance: 'personal' })
    const r = await m.svc.draftAndStage(ACTOR, { target: TARGET, thread: THREAD })
    expect(m.calls).toHaveLength(2)
    expect(m.cards).toHaveLength(0)
    expect(r).toEqual({
      staged: false,
      skipped: 'contradiction',
      conflict: {
        quote: expect.stringContaining("can't speak to recall"),
        prior: PRIOR,
        prior_at: '2026-10-12T03:00:00.000Z',
      },
      message: expect.stringContaining('和你 10-12 说的矛盾，要你看'),
    })
    expect(r.staged === false && r.message).toContain(PRIOR)
  })

  it('人手动点「起草」那条路照旧：矛盾在草稿上标出来（对上哪一句、哪天说的），由人决定出不出卡', async () => {
    const m = make(["I can't speak to recall claims, sorry."], { stance: 'personal' })
    const d = await m.svc.draft(ACTOR, { target: TARGET, thread: THREAD })
    expect(d.checks).toEqual([
      expect.objectContaining({
        kind: 'contradiction',
        prior: PRIOR,
        prior_at: '2026-10-12T03:00:00.000Z',
        message: '和品牌号 10-12 在这串里说的对不上',
      }),
    ])
    expect(m.cards).toHaveLength(0)
  })

  it('conflictNote：拿不到日期说「之前」', () => {
    expect(conflictNote({ quote: 'no recall', prior: 'there was a recall' })).toBe(
      '和你之前说的矛盾，要你看：你说过「there was a recall」，AI 这次写成了「no recall」，没出卡。',
    )
  })

  it('编的技术细节（显示索引问题、切语言能绕过）：重写还编 → 换成「我去确认一下」', async () => {
    const made =
      "Thanks for flagging! That's a known display indexing issue. Switching the display language fixes it."
    const m = make([made, made], { stance: 'personal' })
    await m.svc.draftAndStage(ACTOR, {
      target: { ...TARGET, parent_text: 'my screen shows garbled text' },
      thread: { ...THREAD, ours: [] },
    })
    const card = m.cards[0]
    expect(card?.body.text).not.toContain('indexing')
    expect(card?.body.text).not.toContain('display language')
    expect(card?.body.text).toContain('Let me double-check that and get back to you.')
    expect(card?.checks?.filter((c) => c.kind === 'ungrounded' && c.fixed === true)).toHaveLength(2)
  })

  it('个人口吻里冒出「DM us / the team」：重写一次；整串没现读成照实标', async () => {
    const m = make(
      [
        'DM us and the team will follow up.',
        'I had the same thing on mine — which store did you buy from?',
      ],
      { stance: 'personal' },
    )
    await m.svc.draftAndStage(ACTOR, {
      target: TARGET,
      thread: {
        ...THREAD,
        ours: [],
        read: 'store',
        note: '这一串没现读成，只看了巡查库里已有的几条。',
      },
    })
    expect(m.calls[1]?.fix?.[0]).toContain('口吻不对')
    expect(m.cards[0]?.body.text).toBe(
      'I had the same thing on mine — which store did you buy from?',
    )
    expect(m.cards[0]?.checks).toEqual([
      { kind: 'thread', message: '这一串没现读成，只看了巡查库里已有的几条。' },
    ])
  })
})

describe('品牌号怎么说话（设置卡）', () => {
  const kit = (ask?: (p: string) => Promise<string | undefined>) =>
    createResearchKit({ profile: () => ({}), ...(ask === undefined ? {} : { ask }) }).kit

  it('从品牌号以前的发言猜：个人口吻 + 原话里的自我介绍；没发言就请人选', async () => {
    const set: RedditPersona[] = []
    const p = createRedditPersona({
      nowMs: () => 0,
      history: () => [
        'I used to work at IVRA, so happy to share what I know.',
        'I think the Go2 is fine for subtitles.',
      ],
      onSet: (x) => set.push(x),
    })
    const plan = await p.setupTarget().research?.(kit())
    expect(plan).toMatchObject({
      stance: {
        value: 'personal',
        why: '品牌号以前这样说过：「I used to work at IVRA, so happy to share what I know」',
      },
      intro: { value: 'I used to work at IVRA, so happy to share what I know' },
      avoid: { value: 'DM us, the team, our team' },
    })
    expect(await p.setupTarget().satisfied()).toBe(false)
    await expect(p.setupTarget().apply({ stance: 'boss' })).rejects.toThrow('口吻要选')
    await p
      .setupTarget()
      .apply({ stance: 'personal', intro: 'I used to work at IVRA', avoid: 'DM me, we' })
    expect(set).toEqual([
      { stance: 'personal', intro: 'I used to work at IVRA', avoid: ['DM me', 'we'] },
    ])
    expect(await p.setupTarget().satisfied()).toBe(true)

    const empty = createRedditPersona({ nowMs: () => 0, history: () => [] })
    expect(await empty.setupTarget().research?.(kit())).toEqual({
      stance: { needs_you: true, why: '还没读到品牌号以前的发言，请你选' },
    })
  })

  it('规则猜不出才问模型；模型给的自我介绍不在原话里就不要（不编身份）', async () => {
    const p = createRedditPersona({ nowMs: () => 0, history: () => ['Nice setup!', 'Cool.'] })
    const plan = await p
      .setupTarget()
      .research?.(kit(async () => '{"stance":"team","intro":"I am the IVRA CEO"}'))
    expect(plan?.stance).toMatchObject({ value: 'team' })
    expect(plan?.intro).toBeUndefined()
  })

  it('没配时一天最多出一次卡', () => {
    let now = 0
    const p = createRedditPersona({ nowMs: () => now })
    expect(p.shouldAsk()).toBe(true)
    expect(p.shouldAsk()).toBe(false)
    now = 21 * 3_600_000
    expect(p.shouldAsk()).toBe(true)
  })
})

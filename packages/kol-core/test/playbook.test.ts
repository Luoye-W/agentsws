/**
 * WP117（66 断点 #1）：红人剧本。
 *
 * 断点 #1 的现象是「让红人岗位找 20 个频道，回的是客服的话」。这个文件钉住的就是
 * 那句话该被判成什么、该先调哪几个工具——**判错一次，整条链后面全是错的**。
 */
import { describe, expect, it } from 'vitest'
import {
  channelInText,
  classifyKolTask,
  describeKolRun,
  KOL_INTENT_ZH,
  parseFollowerBand,
  parseOutreachStep,
  parseWantedCount,
  planKolTools,
  searchQueryOf,
} from '../src/playbook.js'

const FIND = '按这个品类在 YouTube 上找 20 个粉丝 1 万到 10 万的频道，按匹配度排给我'

describe('意图判定', () => {
  it('66 断点 #1 那句话判成「找人」，不是客服的退款窗口', () => {
    const hit = classifyKolTask(FIND)
    expect(hit.intent).toBe('find')
    expect(hit.signals.length).toBeGreaterThan(0)
  })

  it('七类各认得出来', () => {
    expect(classifyKolTask('给这个频道起草一封开发信').intent).toBe('outreach')
    expect(classifyKolTask('发出去超过 7 天还没回音的有哪些').intent).toBe('follow_up')
    expect(classifyKolTask('他要 800 美金，这个报价能接吗').intent).toBe('negotiate')
    expect(classifyKolTask('几个合作分别到哪一步了').intent).toBe('collab_status')
    expect(classifyKolTask('审一条他交的视频').intent).toBe('deliverable_review')
    expect(classifyKolTask('上个月哪几个真带货了，看归因').intent).toBe('attribution')
  })

  it('越具体的赢：「审一下这条视频」是审稿，不是找频道', () => {
    expect(classifyKolTask('审一下这条视频，频道是那个油管的').intent).toBe('deliverable_review')
  })

  it('要的是一封信还是一个价钱：「起草开发信……不提具体报价」判成建联', () => {
    expect(classifyKolTask('给这个频道起草一封开发信：说清寄样安排，不提具体报价').intent).toBe(
      'outreach',
    )
    // 只问价、不提信：还是议价
    expect(classifyKolTask('他要 800 美金，这个报价能接吗').intent).toBe('negotiate')
    // 建联 + 没回音：跟进赢（要的是第二封，不是第一封）
    expect(classifyKolTask('建联发出去超过 7 天还没回音的频道有哪些').intent).toBe('follow_up')
  })

  it('判不出来就是 unknown，不猜一个动作', () => {
    const hit = classifyKolTask('你好')
    expect(hit.intent).toBe('unknown')
    expect(hit.signals).toEqual([])
  })
})

describe('参数抽取', () => {
  it('数量、粉丝区间、渠道、搜索词都从那一句话里读出来', () => {
    expect(parseWantedCount(FIND)).toBe(20)
    expect(parseFollowerBand(FIND)).toEqual({ min: 10_000, max: 100_000 })
    expect(channelInText(FIND)).toBe('youtube')
    expect(searchQueryOf(FIND)).not.toContain('20')
  })

  it('写成纯数字的区间也认', () => {
    expect(parseFollowerBand('粉丝 10000-100000 的')).toEqual({ min: 10_000, max: 100_000 })
    // 两头反了不认（宁可回 undefined 让调用方用默认值，也不静默换个数）
    expect(parseFollowerBand('100000-10000')).toBeUndefined()
    expect(parseFollowerBand('粉丝多一点的')).toBeUndefined()
    expect(parseWantedCount('找一批红人')).toBeUndefined()
  })

  it('第几封：默认首封，点名了才是跟进 / 收尾', () => {
    expect(parseOutreachStep('起草一封开发信')).toBe('first')
    expect(parseOutreachStep('再发一封跟进')).toBe('follow_up')
    expect(parseOutreachStep('发最后一封收尾')).toBe('final')
  })

  it('五个渠道词都认；一个都不点名就 undefined（按职责自己的渠道）', () => {
    expect(channelInText('那个 Instagram 的人')).toBe('instagram')
    expect(channelInText('tiktok 上那条')).toBe('tiktok')
    expect(channelInText('脸书主页')).toBe('facebook')
    expect(channelInText('推特上那个')).toBe('x')
    expect(channelInText('随便找几个人')).toBeUndefined()
  })
})

describe('工具计划', () => {
  const base = { channel: 'youtube', text: FIND } as const

  it('找人：只调一次搜索，数量与渠道就是那句话里的', () => {
    const plan = planKolTools('find', { ...base })
    expect(plan.map((p) => p.tool)).toEqual(['search_creators'])
    expect(plan[0]?.input.limit).toBe(20)
    expect(plan[0]?.input.channel).toBe('youtube')
  })

  it('找人 + 有活动名：搜完进候选池（清单卡，人点了才建合作）', () => {
    const plan = planKolTools('find', { ...base, campaign: '春季新品' })
    expect(plan.map((p) => p.tool)).toEqual(['search_creators', 'add_to_campaign'])
    expect(plan[1]?.input.campaign).toBe('春季新品')
  })

  it('建联：先读这个人、再查政策、最后才起草——先读后写', () => {
    const plan = planKolTools('outreach', {
      channel: 'youtube',
      text: '给这个频道起草一封开发信',
      creator_id: 'cr_1',
      product: '充电宝',
    })
    expect(plan.map((p) => p.tool)).toEqual(['get_creator', 'search_policies', 'draft_outreach'])
    expect(plan[2]?.input).toMatchObject({ creator_id: 'cr_1', step: 'first', product: '充电宝' })
  })

  it('建联但现场没有 creator_id：降级成找人，不编一个 id', () => {
    const plan = planKolTools('outreach', { channel: 'youtube', text: '起草一封开发信' })
    expect(plan.map((p) => p.tool)).toEqual(['search_creators'])
  })

  it('议价：读完合作与政策就停——价格永远是人在卡上填的那个数', () => {
    const plan = planKolTools('negotiate', { channel: 'youtube', text: '他要 800 美金' })
    expect(plan.map((p) => p.tool)).toEqual(['list_collaborations', 'search_policies'])
    expect(plan.some((p) => p.tool.startsWith('advance'))).toBe(false)
  })

  it('跟进：有人就起草下一封，没点名谁就先把清单读出来', () => {
    expect(
      planKolTools('follow_up', { channel: 'youtube', text: '催一下', creator_id: 'cr_2' }).map(
        (p) => p.tool,
      ),
    ).toEqual(['list_collaborations', 'draft_outreach'])
    expect(
      planKolTools('follow_up', { channel: 'youtube', text: '谁还没回' }).map((p) => p.tool),
    ).toEqual(['list_collaborations'])
  })

  it('审交付物：没点名哪一条就只列待审的；点名了才提一条验收意见', () => {
    expect(
      planKolTools('deliverable_review', { channel: 'youtube', text: '有什么要审的' }).map(
        (p) => p.tool,
      ),
    ).toEqual(['list_deliverables'])
    const full = planKolTools('deliverable_review', {
      channel: 'youtube',
      text: '审一下',
      collaboration_id: 'cb_1',
      deliverable_id: 'dv_1',
    })
    expect(full.map((p) => p.tool)).toEqual([
      'list_deliverables',
      'search_policies',
      'review_deliverable',
    ])
    expect(full[0]?.input).toEqual({ collaboration_id: 'cb_1' })
  })

  it('归因：有合作就建追踪链接，没有就先读清单', () => {
    expect(
      planKolTools('attribution', {
        channel: 'youtube',
        text: '看归因',
        collaboration_id: 'cb_1',
        target_url: 'https://example.com/p',
      }).map((p) => p.tool),
    ).toEqual(['list_collaborations', 'create_tracked_link'])
    expect(
      planKolTools('attribution', { channel: 'youtube', text: '看归因' }).map((p) => p.tool),
    ).toEqual(['list_collaborations'])
  })

  it('看进展与 unknown 都只读一条清单', () => {
    expect(
      planKolTools('collab_status', { channel: 'youtube', text: '到哪一步了' }).map((p) => p.tool),
    ).toEqual(['list_collaborations'])
    expect(
      planKolTools('unknown', { channel: 'youtube', text: '你好' }).map((p) => p.tool),
    ).toEqual(['list_collaborations'])
  })

  it('用户点名的渠道盖过这条职责自己的渠道', () => {
    const plan = planKolTools('find', { channel: 'youtube', text: '在 tiktok 上找 5 个人' })
    expect(plan[0]?.input.channel).toBe('tiktok')
    expect(plan[0]?.input.limit).toBe(5)
  })

  it('搜索词全被噪声词吃掉时退回渠道名，不发一个空 q', () => {
    const plan = planKolTools('find', { channel: 'youtube', text: '找' })
    expect(plan[0]?.input.q).toBe('youtube')
  })
})

describe('摘要', () => {
  it('一句人话，把这次真干过的事按顺序串起来', () => {
    expect(describeKolRun({ intent: 'find', readTools: ['search_creators'], found: 12 })).toBe(
      '找人；找到 12 个候选；查了 search_creators',
    )
    expect(
      describeKolRun({
        intent: 'outreach',
        readTools: ['get_creator', 'get_creator'],
        drafted: true,
      }),
    ).toBe('建联起草；查了 get_creator；起草了一封开发信（待批）')
    expect(
      describeKolRun({
        intent: 'negotiate',
        readTools: [],
        stagedWhat: '合作',
        askedWhat: '这个价能接吗',
        exhausted: 'max_tool_calls',
      }),
    ).toBe(
      '议价；提了一条合作（待批）；问了一句：这个价能接吗；max_tool_calls 预算耗尽，先停在这里',
    )
  })

  it('七类意图都有一个人话名字', () => {
    for (const key of Object.keys(KOL_INTENT_ZH)) expect(KOL_INTENT_ZH[key as 'find']).toBeTruthy()
  })
})

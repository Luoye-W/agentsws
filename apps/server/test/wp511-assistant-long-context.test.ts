/**
 * WP511（决策 1544–1546，docs/115 §4 第 2–4 条）助理长对话：附件到达时卸载、要时取回；原话预算按真实窗口（封顶 96K）
 * 并用模型报回的用量校正估算；「打开那一段」翻原话；诊断（翻旧账命中、纠正次数）。真网关 + 脚本 provider，不联网。
 */
import type { FreeChatFrame, FreeChatMessageView } from '@agentsws/api'
import type { ChatMessage, ModelProvider } from '@agentsws/contracts'
import { createModelGateway } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import type { Assistant } from '../src/assistant.js'
import {
  attachmentGist,
  attachmentParts,
  attachmentRef,
  parseAttachmentRef,
  readAttachmentText,
} from '../src/assistant-files.js'
import {
  contextDiagnostics,
  contextWindowOf,
  isCorrection,
  nextTokenRatio,
  RAW_BUDGET_CAP,
  rawBudget,
} from '../src/assistant-thread.js'
import { createFreeChatPort, type FreeChatOptions, TURN_TAIL_HEAD } from '../src/free-chat.js'
import { createFreeChatStore } from '../src/free-chat-store.js'

const actor = { workspace_id: 'ws_1', person_id: 'per_me', assignment_id: 'asg_me' }
const ref = { provider: 'deepseek', model: 'deepseek-flash' }

interface Seen {
  messages: ChatMessage[]
  tools: string[]
}

const text = (m: ChatMessage | undefined): string =>
  typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')
const isSummary = (s: Seen): boolean =>
  text(s.messages[0]).includes('话题小结') || text(s.messages[0]).includes('压缩前半段')
const strip = (content: string): string => content.split(`\n\n${TURN_TAIL_HEAD}`)[0] ?? ''

/**
 * 脚本模型：「读附件」→ 从上下文里抄第一个附件编号调 `read_attachment`（带关键词就按关键词）；
 * 「打开第 N 段」→ 调 `open_conversation_segment`；「翻 X」→ 调 `recall_conversation`；有工具结果 → 照着说。
 * `usage` 可以换（校正估算那条用）。
 */
function provider(seen: Seen[], usage: { input_tokens: number }): ModelProvider {
  return {
    ref,
    capabilities: { vision: true, image_generation: false },
    async complete(req) {
      const one: Seen = { messages: req.messages, tools: (req.tools ?? []).map((t) => t.name) }
      seen.push(one)
      const u = { input_tokens: usage.input_tokens, output_tokens: 5, cached_tokens: 0 }
      if (isSummary(one)) return { text: 'AI 小结\n## 定了什么\n- 退货期限 30 天', usage: u }
      const asked = strip(text([...req.messages].reverse().find((m) => m.role === 'user')))
      const last = req.messages.at(-1)
      const all = req.messages.map(text).join('\n')
      const call = (name: string, input: Record<string, unknown>) => ({
        text: '',
        tool_calls: [{ id: `call_${seen.length}`, name, input }],
        usage: u,
      })
      if (last?.role !== 'tool') {
        const read = /^读附件\s*(.*)$/u.exec(asked)
        const refHit = /编号 (fmsg_[^\s；，）]+)/u.exec(all)
        if (read !== null && one.tools.includes('read_attachment') && refHit !== null)
          return call('read_attachment', {
            ref: refHit[1],
            ...(read[1] === '' ? {} : { query: read[1] }),
          })
        const open = /^打开第 (\d+) 段/u.exec(asked)
        if (open !== null && one.tools.includes('open_conversation_segment'))
          return call('open_conversation_segment', { segment: Number(open[1]) })
        const find = /^翻 (.+)$/u.exec(asked)
        if (find !== null && one.tools.includes('recall_conversation'))
          return call('recall_conversation', { query: find[1] })
      }
      const out =
        last?.role === 'tool'
          ? `照着说：${text(last).slice(0, 400)}`
          : `收到：${asked.slice(0, 10)}`
      req.on_delta?.(out)
      return { text: out, usage: u }
    },
  }
}

const fakeAssistant = {
  tools: () => [],
  promptLines: async () => ['用户的岗位：', '- 客服'],
  call: async () => ({ content: '{}' }),
  fanout: {},
  direct: async () => ({ reason: '不交' }),
  state: async () => ({ suggestions: [], targets: [] }),
  progressOf: async () => [],
} as unknown as Assistant

function setup(over: Partial<FreeChatOptions> & { window?: number } = {}) {
  let now = '2026-10-16T02:00:00.000Z'
  const seen: Seen[] = []
  const usage = { input_tokens: 10 }
  const observed: { type: string; payload: Record<string, unknown> }[] = []
  const clock = { now: () => now }
  const gateway = createModelGateway({
    providers: [provider(seen, usage)],
    policy: { default: ref, prices: { 'deepseek/deepseek-flash': { in: 0, out: 0, cached: 0 } } },
    clock,
    eventSink: () => undefined,
    env: {},
  })
  const store = createFreeChatStore()
  let n = 0
  const { window, ...rest } = over
  const port = createFreeChatPort({
    clock,
    store,
    assistant: fakeAssistant,
    gateway: async () => gateway,
    models: async () => ({
      chatChoices: () => [
        {
          id: 'deepseek/deepseek-flash',
          label: 'DS',
          official: false,
          vision: 'ok',
          ...(window === undefined ? {} : { context_window: window }),
        },
      ],
      defaultRef: () => ref,
      configured: () => true,
    }),
    roleOf: () => 'common.owner',
    humanize: (e) => (e instanceof Error ? e.message : String(e)),
    newId: (prefix) => {
      n += 1
      return `${prefix}_${String(n).padStart(4, '0')}`
    },
    tzOffsetMin: 480,
    timeZone: () => 'Asia/Shanghai',
    memory: { auto: () => true, changed: () => undefined },
    observe: (_a, type, payload) => observed.push({ type, payload }),
    ...rest,
  })
  const say = async (
    said: string,
    files?: { name: string; data: string }[],
  ): Promise<FreeChatMessageView> => {
    const sid = (await port.thread?.(actor))?.session.id ?? ''
    const frames: FreeChatFrame[] = []
    await port.turn(
      actor,
      { session_id: sid, text: said, ...(files === undefined ? {} : { files }) },
      (f) => frames.push(f),
      new AbortController().signal,
    )
    const done = frames.find((f) => f.type === 'done')
    if (done?.type !== 'done') throw new Error(`没答完：${JSON.stringify(frames)}`)
    return done.message
  }
  const chats = () => seen.filter((s) => !isSummary(s))
  const contexts = () =>
    observed.filter((o) => o.type === 'assistant.context').map((o) => o.payload)
  return {
    port,
    store,
    seen,
    chats,
    contexts,
    usage,
    say,
    at: (iso: string) => {
      now = iso
    },
  }
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

/** 一份会议纪要：标题、开头一段，后面埋一个只在深处出现的数（探针）。 */
const MINUTES = [
  '# 10-16 周会纪要',
  '',
  '本周重点是 Reddit 冷启动和退货口径统一，客服、社媒两个岗位都参加了。',
  '',
  ...Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 条：常规事项${'，照旧推进'.repeat(8)}。`),
  '',
  '补充：双十一预售定金定为 88 元，尾款 11 月 10 日开付。',
].join('\n')

describe('WP511 附件到达时卸载、要时取回（决策 1544）', () => {
  it('附上的那两轮带全文；第三轮起换成「标题 + 开头 + 编号」占位，逐字不变；读附件按编号取回深处原文', async () => {
    const t = setup()
    await t.say('看下这份纪要', [{ name: '周会纪要.md', data: b64(MINUTES) }])
    t.at('2026-10-16T02:05:00.000Z')
    await t.say('有几个重点')
    t.at('2026-10-16T02:10:00.000Z')
    await t.say('好的')
    t.at('2026-10-16T02:15:00.000Z')
    await t.say('继续')
    const [r1, r2, r3] = t.chats().map((c) => c.messages.map(text).join('\n'))
    expect(r1).toContain('定金定为 88 元')
    expect(r2).toContain('定金定为 88 元')
    expect(r3).not.toContain('定金定为 88 元')
    expect(r3).toMatch(/附件「周会纪要\.md」（\d+ 字，编号 fmsg_\d+\/1；/u)
    // 标题与开头是外来文字，围起来（围栏里全角标点归一成半角）
    expect(r3).toMatch(/标题[:：]10-16 周会纪要/u)
    expect(r3).toMatch(/开头[:：]本周重点是 Reddit 冷启动/u)
    // 占位字节固定：第 4 轮里那句话和第 3 轮一模一样（只往后追加，缓存照样命中）
    const userOf = (i: number) =>
      t.chats()[i]?.messages.find((m) => text(m).includes('看下这份纪要'))
    expect(text(userOf(3))).toBe(strip(text(userOf(2))))
    // 附过资料：挂「读附件」、系统提示里有那一句
    expect(t.chats()[2]?.tools).toContain('read_attachment')
    expect(text(t.chats()[2]?.messages[0])).toContain('read_attachment')
    // 读附件按关键词取回深处那一段
    t.at('2026-10-16T02:20:00.000Z')
    const reply = await t.say('读附件 定金')
    expect(reply.text).toContain('定金定为 88 元')
    expect(t.contexts().at(-1)).toMatchObject({ attachment_reads: 1, offloaded: 1 })
  })

  it('段内压缩之后附件编号还在小结里，照样取回；翻旧账也搜得到附件正文', async () => {
    const t = setup({ contextWindow: 1600 })
    await t.say('看下这份纪要', [{ name: '周会纪要.md', data: b64(MINUTES) }])
    for (let i = 1; i <= 6; i += 1) {
      t.at(`2026-10-16T02:${String(i * 5).padStart(2, '0')}:00.000Z`)
      await t.say(`第${i}句${'很长的一句话'.repeat(20)}`)
    }
    const sys = text(t.chats().at(-1)?.messages[0])
    expect(sys).toContain('这个话题前面聊过的（已压缩）')
    expect(sys).toMatch(
      /附过的资料（要细节用 read_attachment 按编号取回）：「周会纪要\.md」编号 fmsg_\d+\/1/u,
    )
    t.at('2026-10-16T03:00:00.000Z')
    expect((await t.say('读附件 尾款')).text).toContain('11 月 10 日')
    const hits = (await t.port.searchHistory?.(actor, { q: '定金' })) ?? []
    expect(hits.some((h) => h.attachment === '周会纪要.md' && h.snippet.includes('88 元'))).toBe(
      true,
    )
  })
})

describe('WP511 原话预算按真实窗口、封顶 96K，估算用真实用量校正（决策 1545）', () => {
  it('纯函数：窗口取法、预算封顶、换算比只认像真的用量', () => {
    expect(rawBudget(64_000)).toBe(32_000)
    expect(rawBudget(1_000_000)).toBe(RAW_BUDGET_CAP)
    expect(RAW_BUDGET_CAP).toBe(96_000)
    expect(contextWindowOf({ id: 'x/m', context_window: 200_000 }, 400)).toBe(200_000)
    expect(contextWindowOf({ id: 'deepseek/deepseek-flash' }, 400)).toBe(400)
    expect(contextWindowOf({ id: 'agentsws_cloud/deepseek-v4-pro' })).toBe(1_000_000)
    expect(contextWindowOf({ id: 'relay/some-model' })).toBe(64_000)
    // 太小的请求、替身回的固定数：不动
    expect(nextTokenRatio(undefined, 1000, 600)).toBeUndefined()
    expect(nextTokenRatio(0.8, 10_000, 10)).toBe(0.8)
    // 中文按一个字 1 token 估，真的约 0.6：第一次直接取样，之后滑动平均
    expect(nextTokenRatio(undefined, 10_000, 6000)).toBe(0.6)
    expect(nextTokenRatio(0.6, 10_000, 9000)).toBe(0.69)
    expect(nextTokenRatio(1.4, 10_000, 29_000)).toBe(1.5)
  })

  it('每轮记窗口、预算、换算比；模型报回的用量校正估算后存在这一段上', async () => {
    const t = setup({ window: 1_000_000 })
    await t.say(`看一下${'很长的一句话'.repeat(1200)}`)
    // 估算约 7K+：报回 0.6 倍
    const est = Number(t.contexts()[0]?.system_tokens ?? 0)
    expect(est).toBeGreaterThan(0)
    t.usage.input_tokens = 6000
    t.at('2026-10-16T02:05:00.000Z')
    await t.say(`再看${'很长的一句话'.repeat(1200)}`)
    t.at('2026-10-16T02:10:00.000Z')
    await t.say('好')
    const [c1, c2, c3] = t.contexts()
    expect(c1).toMatchObject({ context_window: 1_000_000, raw_budget: 96_000, token_ratio: 1 })
    expect(c2?.token_ratio).toBe(1)
    expect(Number(c3?.token_ratio)).toBeLessThan(1)
    const sid = (await t.port.thread?.(actor))?.session.id ?? ''
    expect(t.store.segments(sid).at(-1)?.token_ratio).toBe(c3?.token_ratio)
  })

  it('诊断：纠正次数、翻旧账命中；汇总成每百轮纠正几次', async () => {
    const t = setup()
    await t.say('退货期限定 30 天')
    t.at('2026-10-17T03:00:00.000Z')
    await t.say('不对，我说过是 15 天')
    await t.say('翻 退货')
    await t.say('翻 没聊过的东西')
    const rows = t.contexts()
    expect(rows.map((r) => r.correction === true)).toEqual([false, true, false, false])
    expect(rows.slice(2).map((r) => [r.history_calls, r.history_hits])).toEqual([
      [1, 1],
      [1, 0],
    ])
    const d = contextDiagnostics(rows)
    expect(d).toMatchObject({
      turns: 4,
      corrections_per_100: 25,
      recall_rate: 0.5,
      recall_hit_rate: 0.5,
    })
    expect(isCorrection('上次说的是周三发')).toBe(true)
    expect(isCorrection('帮我写一段开发信')).toBe(false)
  })
})

describe('WP511 打开那一段（决策 1546）', () => {
  it('小结标题带段号；按段号打开以前那一段读原话（附件只留占位），出处记进回复', async () => {
    const t = setup()
    await t.say('退货期限定 30 天，记一下')
    await t.say('附上表', [{ name: '价目.csv', data: b64('型号,价格\nA1,99\nB2,129') }])
    t.at('2026-10-17T03:00:00.000Z')
    await t.say('今天聊点别的')
    await t.port.idle()
    t.at('2026-10-17T03:05:00.000Z')
    const reply = await t.say('打开第 1 段看看当时怎么说的')
    const round = t.chats().at(-2)
    expect(text(round?.messages[0])).toMatch(/（第 1 段，4 句）/u)
    expect(round?.tools).toEqual(
      expect.arrayContaining(['open_conversation_segment', 'read_attachment']),
    )
    expect(reply.text).toContain('第 1 段')
    expect(reply.text).toContain('第 1 句 用户')
    expect(reply.text).toContain('退货期限定 30 天')
    expect(reply.text).toContain('编号 fmsg_')
    expect(reply.recalled?.[0]).toMatchObject({ segment_n: 1, message_n: 1, kind: 'message' })
    expect(t.contexts().at(-1)).toMatchObject({ segment_opens: 1 })
    // 段号认不出：照实说
    t.at('2026-10-17T03:06:00.000Z')
    expect((await t.say('打开第 9 段')).text).toContain('没有第 9 段')
  })

  it('翻旧账结果写「第 N 段第 M 句」', async () => {
    const t = setup()
    await t.say('退货期限定 30 天')
    t.at('2026-10-17T03:00:00.000Z')
    const reply = await t.say('翻 退货')
    // 围栏里全角括号归一成半角
    expect(reply.text).toMatch(/[（(]第 1 段第 1 句[）)]/u)
  })
})

describe('WP511 附件小工具（纯函数）', () => {
  it('编号来回认；标题与开头字节固定；按段切不切半行；按段号读越界读最后一段', () => {
    expect(attachmentRef('fmsg_1', 0)).toBe('fmsg_1/1')
    expect(parseAttachmentRef('fmsg_1/2')).toEqual({ message_id: 'fmsg_1', index: 1 })
    expect(parseAttachmentRef('乱写的')).toBeUndefined()
    const g = attachmentGist(MINUTES)
    expect(g).toEqual(attachmentGist(MINUTES))
    expect(g.title).toBe('10-16 周会纪要')
    expect(g.opening.startsWith('本周重点是')).toBe(true)
    expect(attachmentGist('只有一句话，没有标题。').title).toBeUndefined()
    const parts = attachmentParts(`${'甲'.repeat(10)}\n${'乙'.repeat(10)}`, 15)
    expect(parts).toEqual(['甲'.repeat(10), '乙'.repeat(10)])
    const a = { name: 'a.md', chars: 21, text: `${'甲'.repeat(10)}\n${'乙'.repeat(10)}` }
    expect(readAttachmentText('fmsg_1/1', a, { part: 9 })).toContain('第 1 / 1 段')
    expect(readAttachmentText('fmsg_1/1', a, { query: '丙' })).toContain('没找到')
    expect(
      readAttachmentText('fmsg_1/1', { name: 'b.pdf', chars: 0, unreadable: '扫描件' }, {}),
    ).toContain('读不出文字')
  })
})

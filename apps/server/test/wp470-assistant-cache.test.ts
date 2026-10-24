/**
 * WP470（决策 1543，docs/115 §4 第 1 条）助理与随便聊按缓存友好的顺序拼上下文（真网关 + 脚本 provider，不联网）：
 * 系统提示只放不变的（这一段开始时冻结记忆与话题小结），每轮会变的接在这一轮那句用户话后面；
 * 工具清单一轮之内固定、按名字排；`assistant.context` 记模型报的输入 / 命中 token。
 */
import type { FreeChatFrame, FreeChatMessageView } from '@agentsws/api'
import type { ChatMessage, ModelProvider } from '@agentsws/contracts'
import { createModelGateway } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import type { Assistant } from '../src/assistant.js'
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

/** 末尾附加拿掉（存着的那句原话）。 */
const strip = (content: string): string => content.split(`\n\n${TURN_TAIL_HEAD}`)[0] ?? ''
const tailOf = (content: string): string => content.slice(content.indexOf(TURN_TAIL_HEAD))

/**
 * 脚本模型：小结那一问可以先卡住（`gate`），放行后回一份 AI 小结；用户说「记住：x」→ 回答末尾写 <remember>；
 * 说「翻 N 次」且挂了翻旧账工具 → 连着调 N 次；有工具结果 → 照着说；其余回一句。用量里 6 / 10 命中缓存。
 */
function provider(seen: Seen[], gate: { wait?: Promise<void> }): ModelProvider {
  return {
    ref,
    capabilities: { vision: true, image_generation: false },
    async complete(req) {
      const one: Seen = { messages: req.messages, tools: (req.tools ?? []).map((t) => t.name) }
      seen.push(one)
      const usage = { input_tokens: 10, output_tokens: 5, cached_tokens: 6 }
      if (isSummary(one)) {
        await gate.wait
        return { text: 'AI 起的标题\n## 谁\n- 客服\n## 定了什么\n- 退货期限 30 天', usage }
      }
      const asked = strip(text([...req.messages].reverse().find((m) => m.role === 'user')))
      const last = req.messages.at(-1)
      const times = /翻 (\d) 次/u.exec(asked)
      const tools = req.messages.filter((m) => m.role === 'tool').length
      if (times !== null && one.tools.includes('recall_conversation') && tools < Number(times[1]))
        return {
          text: '',
          tool_calls: [
            { id: `call_${tools}`, name: 'recall_conversation', input: { query: '退货' } },
          ],
          usage,
        }
      let out: string
      if (last?.role === 'tool') out = `照翻到的说：${text(last).slice(0, 40)}`
      else if (asked.startsWith('记住：')) out = `好的。\n<remember>${asked.slice(3)}</remember>`
      else out = `收到：${asked.slice(0, 10)}`
      req.on_delta?.(out)
      return { text: out, usage }
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

function setup(over: Partial<FreeChatOptions> & { plain?: boolean } = {}) {
  let now = '2026-10-16T02:00:00.000Z'
  const seen: Seen[] = []
  const gate: { wait?: Promise<void> } = {}
  const observed: { type: string; payload: Record<string, unknown> }[] = []
  const clock = { now: () => now }
  const gateway = createModelGateway({
    providers: [provider(seen, gate)],
    policy: { default: ref, prices: { 'deepseek/deepseek-flash': { in: 0, out: 0, cached: 0 } } },
    clock,
    eventSink: () => undefined,
    env: {},
  })
  const store = createFreeChatStore()
  let n = 0
  const { plain, ...rest } = over
  const port = createFreeChatPort({
    clock,
    store,
    ...(plain === true ? {} : { assistant: fakeAssistant }),
    gateway: async () => gateway,
    models: async () => ({
      chatChoices: () => [
        { id: 'deepseek/deepseek-flash', label: 'DS', official: false, vision: 'ok' },
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
    web: {
      status: async () => ({ available: true }),
      search: async () => ({ sources: [{ url: 'https://example.com/a', title: 'A' }] }),
    },
    knowledge: async () => [{ fact_card_id: 'fc_1', text: '退货期限是 30 天' }],
    observe: (_a, type, payload) => observed.push({ type, payload }),
    ...rest,
  })
  const at = (iso: string) => {
    now = iso
  }
  const say = async (
    session_id: string,
    said: string,
    extra: { web_search?: boolean; knowledge?: boolean } = {},
  ): Promise<FreeChatMessageView> => {
    const frames: FreeChatFrame[] = []
    await port.turn(
      actor,
      { session_id, text: said, ...extra },
      (f) => frames.push(f),
      new AbortController().signal,
    )
    const done = frames.find((f) => f.type === 'done')
    if (done?.type !== 'done') throw new Error(`没答完：${JSON.stringify(frames)}`)
    return done.message
  }
  const chats = () => seen.filter((s) => !isSummary(s))
  const session = async () =>
    plain === true
      ? (await port.create(actor, {})).id
      : ((await port.thread?.(actor))?.session.id ?? '')
  return { port, store, seen, chats, observed, at, say, gate, session }
}

/** 第 2 轮的 messages 开头 = 第 1 轮的 messages（那句话去掉末尾附加）+ 第 1 轮的回答。 */
function expectAppendOnly(r1: ChatMessage[], r2: ChatMessage[], answer: string): void {
  const last1 = text(r1.at(-1))
  expect(last1).toContain(TURN_TAIL_HEAD)
  expect(r2.slice(0, r1.length - 1)).toEqual(r1.slice(0, -1))
  expect(r2[r1.length - 1]).toEqual({ ...r1.at(-1), content: strip(last1) })
  expect(r2[r1.length]).toEqual({ role: 'assistant', content: answer })
  expect(r2.length).toBe(r1.length + 2)
  expect(text(r2.at(-1))).toContain(TURN_TAIL_HEAD)
}

describe('WP470 助理：只往后追加、会变的放末尾', () => {
  it('同一段连续两轮：第 2 轮开头逐字等于第 1 轮 + 第 1 轮的回答（只有末尾附加不同）', async () => {
    const t = setup()
    const sid = await t.session()
    const a1 = await t.say(sid, '退货怎么处理')
    t.at('2026-10-16T02:10:00.000Z')
    await t.say(sid, '那期限呢')
    const [r1, r2] = t.chats()
    expectAppendOnly(r1?.messages ?? [], r2?.messages ?? [], a1.text)
    // 系统提示里没有时间；时间按公司时区、按小时取整接在末尾
    expect(text(r1?.messages[0])).not.toMatch(/现在是|T02:00/u)
    expect(tailOf(text(r1?.messages.at(-1)))).toContain(
      '现在是 2026-10-16（周五）10:00 前后，公司时区 Asia/Shanghai（UTC+08:00）',
    )
    // 工具清单按名字排、一轮之内不变
    expect(r1?.tools).toEqual(['web_search'])
    expect(r2?.tools).toEqual(r1?.tools)
    // 存下来的还是原话
    const stored = await t.port.messages(actor, sid)
    expect(stored.map((m) => m.text)).toEqual([
      '退货怎么处理',
      a1.text,
      '那期限呢',
      '收到：那期限呢',
    ])
  })

  it('隔 59 分钟：系统提示逐字相同；跨整点：只有末尾时间那句不同', async () => {
    const t = setup()
    const sid = await t.session()
    await t.say(sid, '第一句')
    t.at('2026-10-16T02:59:00.000Z')
    await t.say(sid, '第二句')
    t.at('2026-10-16T03:20:00.000Z')
    await t.say(sid, '第三句')
    const [r1, r2, r3] = t.chats()
    expect(text(r2?.messages[0])).toBe(text(r1?.messages[0]))
    expect(text(r3?.messages[0])).toBe(text(r1?.messages[0]))
    const tail1 = tailOf(text(r1?.messages.at(-1)))
    const tail2 = tailOf(text(r2?.messages.at(-1)))
    const tail3 = tailOf(text(r3?.messages.at(-1)))
    expect(tail2).toBe(tail1)
    const diff = (a: string, b: string) => {
      const x = a.split('\n')
      const y = b.split('\n')
      return x.filter((l, i) => l !== y[i])
    }
    expect(diff(tail3, tail2)).toEqual([
      '现在是 2026-10-16（周五）11:00 前后，公司时区 Asia/Shanghai（UTC+08:00）。没写时区的日期和时间都按这个时区理解。',
    ])
  })

  it('段内新记一条记忆：这一段系统提示不变、新条目在末尾附加里；下一段开始进系统提示', async () => {
    const t = setup()
    const sid = await t.session()
    await t.say(sid, '记住：回 Reddit 一律用英文')
    expect(t.store.memories(actor.person_id).map((m) => m.text)).toEqual(['回 Reddit 一律用英文'])
    t.at('2026-10-16T02:05:00.000Z')
    await t.say(sid, '在吗')
    const [r1, r2] = t.chats()
    expect(text(r2?.messages[0])).toBe(text(r1?.messages[0]))
    expect(text(r2?.messages[0])).not.toContain('回 Reddit 一律用英文')
    expect(tailOf(text(r2?.messages.at(-1)))).toContain('- 回 Reddit 一律用英文')
    // 隔了 2 小时以上 → 新的一段：系统提示里有它，末尾附加里不再重复
    t.at('2026-10-16T05:00:00.000Z')
    await t.say(sid, '新的一段')
    const r3 = t.chats().at(-1)
    expect(text(r3?.messages[0])).toContain('- 回 Reddit 一律用英文')
    expect(tailOf(text(r3?.messages.at(-1)))).not.toContain('回 Reddit')
    const ctx = t.observed.filter((o) => o.type === 'assistant.context').map((o) => o.payload)
    expect(ctx.map((c) => c.new_memory)).toEqual([0, 1, 0])
    await t.port.idle()
  })

  it('后台 AI 小结替换了规则小结：这一段里系统提示不变，下一段才换成 AI 那份', async () => {
    const t = setup()
    const sid = await t.session()
    await t.say(sid, '退货怎么处理比较好')
    // 小结那一问先卡住：新段第一轮只能用规则小结
    let release: () => void = () => undefined
    t.gate.wait = new Promise<void>((r) => {
      release = r
    })
    t.at('2026-10-16T05:00:00.000Z')
    await t.say(sid, '帮我想个新品名字')
    release()
    await t.port.idle()
    const segs = (await t.port.thread?.(actor))?.segments ?? []
    expect(segs[0]?.title).toBe('AI 起的标题')
    t.at('2026-10-16T05:10:00.000Z')
    await t.say(sid, '再来一个')
    const chats = t.chats()
    const [, s1, s2] = chats.map((c) => text(c.messages[0]))
    expect(s1).toContain('最近聊过的几个话题')
    expect(s1).not.toContain('AI 起的标题')
    expect(s2).toBe(s1)
    // 下一段开始换成 AI 那份
    t.at('2026-10-16T09:00:00.000Z')
    await t.say(sid, '第三段')
    await t.port.idle()
    expect(text(t.chats().at(-1)?.messages[0])).toContain('AI 起的标题')
  })

  it('工具一轮之内不撤：次数用完了照挂、执行时拒；最后一圈不挂逼它说完', async () => {
    const t = setup()
    const sid = await t.session()
    await t.say(sid, '退货期限定 30 天')
    t.at('2026-10-17T03:00:00.000Z') // 跨天 → 新段，有更早的段可翻
    const reply = await t.say(sid, '帮我翻 4 次以前说的')
    const rounds = t.chats().slice(1)
    // WP511：有更早的段时多挂「打开那一段」（同样一轮之内不撤）
    const all = ['open_conversation_segment', 'recall_conversation', 'web_search']
    expect(rounds.map((r) => r.tools)).toEqual([all, all, all, all, all])
    const results = (rounds.at(-1)?.messages ?? []).filter((m) => m.role === 'tool').map(text)
    expect(results).toHaveLength(4)
    expect(results[3]).toContain('到上限了')
    expect(reply.text).toContain('照翻到的说')
    await t.port.idle()
  })

  it('联网、公司资料只在末尾附加里；系统提示与工具清单不随开关变', async () => {
    const t = setup()
    const sid = await t.session()
    await t.say(sid, '第一句')
    await t.say(sid, '查一下', { web_search: true, knowledge: true })
    await t.say(sid, '第三句')
    const [r1, r2, r3] = t.chats()
    expect(text(r2?.messages[0])).toBe(text(r1?.messages[0]))
    expect(text(r3?.messages[0])).toBe(text(r1?.messages[0]))
    expect(r2?.tools).toEqual(r1?.tools)
    const tail1 = tailOf(text(r1?.messages.at(-1)))
    const tail2 = tailOf(text(r2?.messages.at(-1)))
    expect(tail1).toContain('没开「联网搜索」')
    expect(tail2).toContain('这一轮最多搜')
    expect(tail2).toContain('[1] 退货期限是 30 天')
    expect(text(r3?.messages.at(-3))).toBe('查一下')
  })

  it('assistant.context 记这一轮模型报的输入 / 命中 token 与命中率（不带正文）', async () => {
    const t = setup()
    const sid = await t.session()
    await t.say(sid, '记住：退货一律先问订单号')
    const ctx = t.observed.find((o) => o.type === 'assistant.context')?.payload
    expect(ctx).toMatchObject({ input_tokens: 10, cached_tokens: 6, cache_ratio: 0.6 })
    expect(ctx?.tail_tokens).toEqual(expect.any(Number))
    expect(JSON.stringify(ctx)).not.toContain('订单号')
  })
})

describe('WP470 随便聊（没装助理）：同样的两条', () => {
  it('连续两轮只往后追加；系统提示里没有时间', async () => {
    const t = setup({ plain: true })
    const sid = await t.session()
    const a1 = await t.say(sid, '你好')
    t.at('2026-10-16T02:30:00.000Z')
    await t.say(sid, '再说一句')
    const [r1, r2] = t.chats()
    expectAppendOnly(r1?.messages ?? [], r2?.messages ?? [], a1.text)
    expect(text(r1?.messages[0]).startsWith('你是「Agents 工坊」里的随便聊助手。\n')).toBe(true)
    expect(text(r1?.messages[0])).not.toContain('现在是')
  })

  it('隔 59 分钟系统提示逐字相同；跨整点只有末尾时间那句不同', async () => {
    const t = setup({ plain: true })
    const sid = await t.session()
    await t.say(sid, '一')
    t.at('2026-10-16T02:59:00.000Z')
    await t.say(sid, '二')
    t.at('2026-10-16T03:01:00.000Z')
    await t.say(sid, '三')
    const [r1, r2, r3] = t.chats()
    expect(text(r2?.messages[0])).toBe(text(r1?.messages[0]))
    expect(text(r3?.messages[0])).toBe(text(r1?.messages[0]))
    expect(tailOf(text(r2?.messages.at(-1)))).toBe(tailOf(text(r1?.messages.at(-1))))
    const a = tailOf(text(r2?.messages.at(-1))).split('\n')
    const b = tailOf(text(r3?.messages.at(-1))).split('\n')
    expect(b.filter((l, i) => l !== a[i])).toHaveLength(1)
    expect(b[1]).toContain('11:00 前后')
  })
})

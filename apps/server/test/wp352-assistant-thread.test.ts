/**
 * WP352（决策 931）助理一条长对话 + 四层上下文（服务端，真网关 + 脚本 provider，不联网）：
 * 分段（隔久了 / 跨天 / 说「换个话题」/ 点钮 / 模型记号）、段内超预算压缩、小结落盘与搜索、
 * 「查以前聊过的」只读且带出处、运行输入里不含早于当前段的原话、老会话迁成一条、每轮记一笔拼了多少。
 */
import type { FreeChatFrame, FreeChatMessageView } from '@agentsws/api'
import type { ChatMessage, ModelProvider } from '@agentsws/contracts'
import { createModelGateway } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import type { Assistant } from '../src/assistant.js'
import { createFreeChatPort, type FreeChatOptions } from '../src/free-chat.js'
import { createFreeChatStore } from '../src/free-chat-store.js'

const actor = { workspace_id: 'ws_1', person_id: 'per_me', assignment_id: 'asg_me' }
const ref = { provider: 'deepseek', model: 'deepseek-flash' }

interface Seen {
  system: string
  rest: ChatMessage[]
  tools: string[]
}

const text = (m: ChatMessage | undefined): string =>
  typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')

/**
 * 脚本模型：小结 / 压缩那一问回一份固定的小结；用户说「上周」且挂了翻旧账工具 → 调它；
 * 有工具结果 → 照着说；用户说「NEWTOPIC」→ 回答开头带换话题记号；其余回一句。
 */
function provider(seen: Seen[]): ModelProvider {
  return {
    ref,
    capabilities: { vision: true, image_generation: false },
    async complete(req) {
      const system = text(req.messages[0])
      const rest = req.messages.slice(1)
      seen.push({ system, rest, tools: (req.tools ?? []).map((t) => t.name) })
      const usage = { input_tokens: 10, output_tokens: 5, cached_tokens: 0 }
      if (system.includes('话题小结') || system.includes('压缩前半段')) {
        const said = text(rest[0])
        const title = said.includes('退货') ? '退货口径' : '别的事'
        return { text: `${title}\n## 谁\n- 客服\n## 定了什么\n- 退货期限 30 天`, usage }
      }
      const last = rest.at(-1)
      const asked = text([...rest].reverse().find((m) => m.role === 'user'))
      let out: string
      if (last?.role === 'tool') out = `照翻到的说：${text(last).slice(0, 300)}`
      else if (
        asked.includes('上周') &&
        (req.tools ?? []).some((t) => t.name === 'recall_conversation')
      )
        return {
          text: '',
          tool_calls: [
            { id: 'call_1', name: 'recall_conversation', input: { query: '退货 期限' } },
          ],
          usage,
        }
      else if (asked.includes('NEWTOPIC')) out = '<new-topic/>好的，聊新的。'
      else out = `收到：${asked.slice(0, 10)}`
      req.on_delta?.(out)
      return { text: out, usage }
    },
  }
}

const fakeAssistant = {
  tools: () => [],
  promptLines: async () => [],
  call: async () => ({ content: '{}' }),
  fanout: {},
  direct: async () => ({ reason: '不交' }),
  state: async () => ({ suggestions: [], targets: [] }),
  progressOf: async () => [],
} as unknown as Assistant

function setup(over: Partial<FreeChatOptions> = {}) {
  let now = '2026-10-16T02:00:00.000Z'
  const seen: Seen[] = []
  const observed: { type: string; payload: Record<string, unknown> }[] = []
  const p = provider(seen)
  const clock = { now: () => now }
  const gateway = createModelGateway({
    providers: [p],
    policy: { default: ref, prices: { 'deepseek/deepseek-flash': { in: 0, out: 0, cached: 0 } } },
    clock,
    eventSink: () => undefined,
    env: {},
  })
  const store = createFreeChatStore()
  let n = 0
  const port = createFreeChatPort({
    clock,
    store,
    assistant: fakeAssistant,
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
    observe: (_a, type, payload) => observed.push({ type, payload }),
    ...over,
  })
  const at = (iso: string) => {
    now = iso
  }
  const say = async (session_id: string, said: string): Promise<FreeChatMessageView> => {
    const frames: FreeChatFrame[] = []
    await port.turn(
      actor,
      { session_id, text: said },
      (f) => frames.push(f),
      new AbortController().signal,
    )
    const done = frames.find((f) => f.type === 'done')
    if (done?.type !== 'done') throw new Error(`没答完：${JSON.stringify(frames)}`)
    return done.message
  }
  return { port, store, seen, observed, at, say }
}

/** 主对话那几问（不含小结 / 压缩那一问）。 */
const chats = (seen: Seen[]) =>
  seen.filter((s) => !s.system.includes('话题小结') && !s.system.includes('压缩前半段'))

describe('WP352 分段', () => {
  it('隔了 2 小时以上切段；旧段出小结落盘；新一轮的输入里没有旧段原话，只有小结', async () => {
    const t = setup()
    const thread = await t.port.thread?.(actor)
    const sid = thread?.session.id ?? ''
    await t.say(sid, '退货怎么处理比较好')
    t.at('2026-10-16T02:30:00.000Z')
    await t.say(sid, '那期限定多少天')
    t.at('2026-10-16T05:00:00.000Z')
    const reply = await t.say(sid, '帮我想个新品名字')
    await t.port.idle()
    const segs = (await t.port.thread?.(actor))?.segments ?? []
    expect(segs.map((s) => [s.reason, s.current])).toEqual([
      ['first', false],
      ['gap', true],
    ])
    expect(segs[0]?.title).toBe('退货口径')
    expect(segs[0]?.summary).toContain('退货期限 30 天')
    expect(reply.segment_id).toBe(segs[1]?.id)
    const last = chats(t.seen).at(-1)
    const raw = (last?.rest ?? []).map(text).join('\n')
    expect(raw).not.toContain('退货怎么处理')
    expect(raw).toContain('帮我想个新品名字')
    // 旧段在开场上下文里只以小结出现（这一轮小结可能还没出来 → 规则小结，也只是一行）
    expect(last?.system).toContain('最近聊过的几个话题')
    // 有更早的段才挂「查以前聊过的」
    expect(last?.tools).toContain('recall_conversation')
    expect(chats(t.seen)[0]?.tools).not.toContain('recall_conversation')
    expect(
      t.observed.some((o) => o.type === 'assistant.topic' && o.payload.summarized_by === 'ai'),
    ).toBe(true)
  })

  it('跨天切段（按本地时区）；说「换个话题」切段；点「换个话题」切段', async () => {
    const t = setup()
    const sid = (await t.port.thread?.(actor))?.session.id ?? ''
    t.at('2026-10-16T15:50:00.000Z') // 东八区 23:50
    await t.say(sid, '今天的单子')
    t.at('2026-10-16T16:10:00.000Z') // 东八区次日 00:10，只隔 20 分钟
    await t.say(sid, '接着说')
    t.at('2026-10-16T16:20:00.000Z')
    await t.say(sid, '换个话题，聊聊广告')
    t.at('2026-10-16T16:25:00.000Z')
    const view = await t.port.newTopic?.(actor)
    // 刚点完，空的新段已经开好；再点一次不会多开
    const again = await t.port.newTopic?.(actor)
    expect(view?.segments.map((s) => s.reason)).toEqual(['first', 'day', 'manual', 'manual'])
    expect(again?.segments.length).toBe(4)
    await t.port.idle()
  })

  it('模型在回答开头写换话题记号：这一问一答挪进新段，记号不给人看', async () => {
    const t = setup()
    const sid = (await t.port.thread?.(actor))?.session.id ?? ''
    await t.say(sid, '退货的事')
    t.at('2026-10-16T02:05:00.000Z')
    const reply = await t.say(sid, 'NEWTOPIC 帮我看下广告')
    await t.port.idle()
    expect(reply.error).toBeUndefined()
    expect(reply.text).toBe('好的，聊新的。')
    const msgs = await t.port.messages(actor, sid)
    const segs = (await t.port.thread?.(actor))?.segments ?? []
    expect(segs.map((s) => s.reason)).toEqual(['first', 'topic'])
    expect(msgs.map((m) => m.segment_id)).toEqual([
      segs[0]?.id,
      segs[0]?.id,
      segs[1]?.id,
      segs[1]?.id,
    ])
  })
})

describe('WP352 段内压缩与记账', () => {
  it('当前段原话超预算：较早那截压成段内小结，之后只带小结 + 最近的原话；每轮记一笔拼了多少', async () => {
    // 窗口 400 → 原话预算 200 token；每句约 60 个汉字
    const t = setup({ contextWindow: 400 })
    const sid = (await t.port.thread?.(actor))?.session.id ?? ''
    const long = (i: number) => `第${i}句退货${'很长的话'.repeat(14)}`
    for (let i = 1; i <= 4; i += 1) await t.say(sid, long(i))
    const compacts = t.seen.filter((s) => s.system.includes('压缩前半段'))
    expect(compacts.length).toBeGreaterThan(0)
    const last = chats(t.seen).at(-1)
    expect(last?.system).toContain('这个话题前面聊过的（已压缩）')
    expect((last?.rest ?? []).map(text).join('\n')).not.toContain('第1句退货')
    const ctx = t.observed.filter((o) => o.type === 'assistant.context')
    expect(ctx.length).toBe(4)
    expect(ctx.some((o) => o.payload.compacted_now === true)).toBe(true)
    for (const o of ctx) {
      expect(o.payload).toMatchObject({
        raw_messages: expect.any(Number),
        raw_tokens: expect.any(Number),
      })
      expect(JSON.stringify(o.payload)).not.toContain('很长的话')
    }
  })
})

describe('WP352 翻旧账与搜索', () => {
  it('「查以前聊过的」只读、命中出处；搜索接口搜小结与原话', async () => {
    const t = setup()
    const sid = (await t.port.thread?.(actor))?.session.id ?? ''
    await t.say(sid, '退货期限定 30 天，记一下')
    t.at('2026-10-17T03:00:00.000Z')
    await t.say(sid, '今天先聊别的')
    await t.port.idle()
    const before = (await t.port.messages(actor, sid)).length
    const reply = await t.say(sid, '上周说的退货期限是多少来着')
    expect(reply.text).toContain('照翻到的说')
    expect(reply.text).toContain('2026-10-16')
    expect(reply.recalled?.some((h) => h.kind === 'message' && h.message_id !== undefined)).toBe(
      true,
    )
    // 只读：除了这一问一答没多出任何话，段也没变
    expect((await t.port.messages(actor, sid)).length).toBe(before + 2)
    const hits = (await t.port.searchHistory?.(actor, { q: '退货' })) ?? []
    expect(hits.some((h) => h.kind === 'summary' && h.title === '退货口径')).toBe(true)
    const msg = hits.find((h) => h.kind === 'message')
    expect(msg?.snippet).toContain('退货')
    expect(msg?.segment_id).toBeDefined()
    expect(
      await t.port.searchHistory?.(actor, { q: '退货', since: '2026-10-18T00:00:00.000Z' }),
    ).toEqual([])
  })
})

describe('WP352 老会话迁成一条', () => {
  it('多条老会话按时间拼进来，每条一段；交出去的事那根线跟着挪；会话列表只剩一条', async () => {
    const t = setup()
    const a = await t.port.create(actor, {})
    t.at('2026-10-14T02:00:00.000Z')
    await t.say(a.id, '第一段老话')
    const b = await t.port.create(actor, {})
    t.at('2026-10-15T02:00:00.000Z')
    await t.say(b.id, '第二段老话')
    t.store.putDispatch({
      matter_id: 'mat_1',
      session_id: b.id,
      person_id: actor.person_id,
      at: '2026-10-15T02:00:00.000Z',
      title: '回邮件',
      position_id: 'pos_1',
      position_name: '客服',
      reported: [],
    })
    t.at('2026-10-16T02:00:00.000Z')
    const thread = await t.port.thread?.(actor)
    const sid = thread?.session.id ?? ''
    expect(thread?.segments.map((s) => s.reason)).toEqual(['migrated', 'migrated'])
    const msgs = await t.port.messages(actor, sid)
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
      '第一段老话',
      '第二段老话',
    ])
    expect((await t.port.sessions(actor)).map((s) => s.id)).toEqual([sid])
    expect(t.store.dispatches(actor.person_id)[0]?.session_id).toBe(sid)
    // 再要一次还是这一条
    expect((await t.port.thread?.(actor))?.session.id).toBe(sid)
  })
})

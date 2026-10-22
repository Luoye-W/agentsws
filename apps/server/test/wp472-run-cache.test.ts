/**
 * WP472（docs/116 §6 A / C，决策 1549 / 1551）：岗位 / 事项对话带原文、每次都变的排在后面。
 *
 * - 历史那一条（`matter-history.ts`）：只往后加；附件只留占位；太长一次折一大截、之后照旧只往后加；
 * - 端到端（真 `createRuntime` + 真事项服务，direct 档，替身模型不联网）：同一件事连说 3 句，第 3 句那次运行
 *   第一步的请求以第 2 句那次的为前缀（除末尾「这一次附加」）；岗位状态排在事项摘要之后、时间之前；
 * - 岗位状态：不带「在做事 / 空着」，事项按开的先后排；记忆 / 组件写法两段挪到技能索引之后。
 */
import type { ChatMessage, Completion, MatterEvent, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { createWork } from '@agentsws/work'
import { describe, expect, it, vi } from 'vitest'
import { MEMORY_SECTION_ORDER } from '../src/auto-memory.js'
import {
  foldPoint,
  HISTORY_CAP_TOKENS,
  historyBudgetFor,
  historyText,
  priorTurns,
} from '../src/matter-history.js'
import { createRuntime, GENUI_SECTION_ORDER, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let seq = 0
const ev = (
  kind: MatterEvent['kind'],
  text: string,
  extra: Partial<MatterEvent> = {},
): MatterEvent => {
  seq += 1
  return {
    id: `mev_${String(seq).padStart(4, '0')}`,
    matter_id: 'mat_1',
    at: new Date(Date.UTC(2026, 9, 22, 8, 0, seq)).toISOString(),
    kind,
    text,
    actor: { kind: kind === 'human_message' ? 'person' : 'agent', id: 'x' },
    ...extra,
  }
}

describe('WP472 事项历史：只往后加', () => {
  it('最后一句人话还没回 → 不进历史（它是这一次的话）；工具 / 卡 / 状态行不进；附件只留占位', () => {
    const events = [
      ev('human_message', '帮我查一下上周退货', {
        attachments: [{ name: '退货单.xlsx', chars: 900, text: '很长的表格内容' }],
      }),
      ev('run', 'AI 接着这个事项跑了一次'),
      ev('status', '用了 3 步'),
      ev('agent_message', '上周退了 4 单。'),
      ev('card', '一张卡'),
      ev('human_message', '哪一单最贵？'),
    ]
    const turns = priorTurns(events)
    expect(turns.map((t) => `${t.who}:${t.text}`)).toEqual([
      '人:帮我查一下上周退货\n［附件：退货单.xlsx］',
      '你:上周退了 4 单。',
    ])
    expect(historyText(events, 16_000)).not.toContain('很长的表格内容')
    // 重跑（最后一句是回复）：全进
    expect(priorTurns(events.slice(0, 4))).toHaveLength(2)
  })

  it('连说三句：第 3 次的历史以第 2 次的为前缀', () => {
    const t1 = [ev('human_message', '第一句')]
    const t2 = [...t1, ev('agent_message', '第一句的回复'), ev('human_message', '第二句')]
    const t3 = [...t2, ev('agent_message', '第二句的回复'), ev('human_message', '第三句')]
    expect(historyText(t1, 16_000)).toBeUndefined()
    const h2 = historyText(t2, 16_000) ?? ''
    const h3 = historyText(t3, 16_000) ?? ''
    expect(h3.startsWith(h2)).toBe(true)
    expect(h3.slice(h2.length)).toBe('\n人：第二句\n你：第二句的回复')
  })

  it('太长：一次折一大截放最前，之后照旧只往后加，再超才重折；折点只由前面的话决定', () => {
    const budget = 1_000
    const long = (i: number) => `第 ${i} 句：${'很长的回复内容'.repeat(20)}`
    const events: MatterEvent[] = []
    const texts: string[] = []
    const folds: number[] = []
    for (let i = 0; i < 30; i += 1) {
      events.push(ev(i % 2 === 0 ? 'human_message' : 'agent_message', long(i)))
      texts.push(historyText([...events, ev('human_message', '新的一句')], budget) ?? '')
      folds.push(foldPoint(priorTurns([...events, ev('human_message', '新的一句')]), budget))
    }
    // 折点只会不动或往后跳一大截
    const changes = folds.filter((f, i) => i > 0 && f !== folds[i - 1]).length
    expect(changes).toBeGreaterThan(0)
    expect(changes).toBeLessThan(folds.length / 3)
    for (let i = 1; i < folds.length; i += 1)
      expect(folds[i]).toBeGreaterThanOrEqual(folds[i - 1] ?? 0)
    // 折点没变的相邻两次：后一次的正文以前一次为前缀
    for (let i = 1; i < texts.length; i += 1) {
      if (folds[i] !== folds[i - 1]) continue
      expect((texts[i] ?? '').startsWith(texts[i - 1] ?? '')).toBe(true)
    }
    const last = texts.at(-1) ?? ''
    expect(last).toContain('［更早的对话已折起，每句只留开头］')
  })

  it('预算：窗口的四分之一，封顶 3.2 万；拿不到按 64K', () => {
    expect(historyBudgetFor(undefined)).toBe(16_000)
    expect(historyBudgetFor(1_000_000)).toBe(HISTORY_CAP_TOKENS)
  })
})

describe('WP472 岗位说明里会变的两段排在技能索引（90）之后', () => {
  it('记忆 92、组件写法 / 当场问答 95', () => {
    expect(MEMORY_SECTION_ORDER).toBeGreaterThan(90)
    expect(GENUI_SECTION_ORDER).toBeGreaterThan(MEMORY_SECTION_ORDER)
  })
})

/* ── 端到端：真运行时 + 真事项服务 ── */

const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.support', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const text = (m: ChatMessage): string =>
  typeof m.content === 'string' ? m.content : JSON.stringify(m.content)

describe('WP472 事项对话端到端：连说 3 句', () => {
  it('第 3 句那次第一步的请求以第 2 句那次的为前缀（除末尾这一次附加）；岗位状态在摘要之后、时间之前', async () => {
    let now = Date.parse('2026-10-22T08:00:00.000Z')
    const clock = { now: () => new Date(now).toISOString() }
    const firsts: ChatMessage[][] = []
    let calls = 0
    const models = {
      async complete(req: { messages: ChatMessage[] }) {
        calls += 1
        firsts.push(structuredClone(req.messages))
        return {
          text: `第 ${String(calls)} 次的回复。`,
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
          model: { provider: 'stub', model: 'stub-v1' },
          static_prefix_hash: 'p',
        } satisfies Completion
      },
      async embed() {
        return []
      },
      usage: () => ({}),
      budget: () => ({}),
    } as unknown as ModelGatewayApi
    let cards = 0
    const runtime = createRuntime({
      workspace_id: 'ws_1',
      clock,
      random: () => 0.5,
      seed: 42,
      env: {},
      models,
      // 说到退货时 direct 档会问一道边界选择题（WP232）——替身卡给最小的形状
      approvals: {
        create: async (input: { kind: string; title?: string; subject?: object }) => ({
          id: 'apv_1',
          kind: input.kind,
          state: 'pending',
          title: input.title ?? '',
          subject: input.subject ?? {},
          evidence: {},
        }),
        queue: async () => [],
      } as unknown as RuntimeOptions['approvals'],
      roles,
      appendEvent: () => undefined,
      prefer: 'direct',
      modelRef: () => MODEL,
      hasModel: () => true,
      vertical: () => 'physical',
      timeZone: () => 'Asia/Shanghai',
      // 岗位层：每次运行都变（待定的卡数）——它必须排在摘要之后、时间之前
      dshMode: 'in-process',
    } as unknown as RuntimeOptions)
    // 岗位层：每次运行都变（待定的卡数）——它必须排在摘要之后、时间之前
    runtime.bindPositions({
      positionOf: () => ({ position_id: 'support' }),
      layerContext: async () => {
        cards += 1
        return {
          position_id: 'support',
          position_name: '客服',
          panel: [{ label: '待你定的卡', value: String(cards) }],
          alerts: [],
          open_matters: [],
        }
      },
    } as unknown as Parameters<typeof runtime.bindPositions>[0])
    const work = createWork({
      workspace_id: 'ws_1',
      clock,
      random: () => 0.5,
      startRun: (input) => runtime.startRun(input),
      summarize: ({ run_summary }) => run_summary,
    })
    runtime.bind(work)
    const matter = work.createMatter({ kind: 'adhoc', title: '退货的事' })
    const actor = { person_id: 'per_1', assignment_id: 'asg_1' }
    for (const said of ['上周退了几单？', '哪一单最贵？', '把那单的客户邮件起草一下']) {
      now += 7 * 60_000 // 跨了整点也没关系：时间在最后
      await work.say(matter.id, { ...actor, text: said })
    }
    expect(firsts).toHaveLength(3)
    const [, second, third] = firsts as [ChatMessage[], ChatMessage[], ChatMessage[]]
    const histIdx = (ms: ChatMessage[]) => ms.findIndex((m) => text(m).startsWith('[history:'))
    const i2 = histIdx(second)
    const i3 = histIdx(third)
    expect(i2).toBeGreaterThan(0)
    expect(i3).toBe(i2)
    // 历史之前逐字一样；历史这条是上一次的前缀 + 新增
    expect(JSON.stringify(third.slice(0, i3))).toBe(JSON.stringify(second.slice(0, i2)))
    expect(text(third[i3] as ChatMessage).startsWith(text(second[i2] as ChatMessage))).toBe(true)
    expect(text(third[i3] as ChatMessage)).toContain('人：哪一单最贵？')
    expect(text(third[i3] as ChatMessage)).toContain('你：第 2 次的回复。')
    // 历史之后：事项摘要 → 岗位状态 → 时间 → 这一次的话（都是 user 层）
    const tail = third.slice(i3 + 1).map((m) => `${m.role}:${/^\[([a-z_]+):/.exec(text(m))?.[1]}`)
    expect(tail).toEqual(['user:matter_summary', 'user:summary', 'user:time', 'user:thread'])
    expect(text(third.at(-1) as ChatMessage)).toContain('把那单的客户邮件起草一下')
    // 组件写法那一段排在岗位说明最后（技能索引之后，WP472）
    const persona = text(second[0] as ChatMessage)
    const headers = [...persona.matchAll(/^## (\S+)/gmu)].map((m) => m[1])
    expect(headers.at(-1)).toBe('genui_display')
    // 历史和它之前的都没有每次都变的东西：系统提示里没有岗位状态
    expect(
      second.filter((m) => m.role === 'system').some((m) => text(m).includes('待你定的卡')),
    ).toBe(false)
  })
})

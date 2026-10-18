/**
 * WP415（自查 R8）：stub 没剧本照实说「演示里没有这段」，不再套客服回信卡。
 *
 * 1. Amazon 店铺运营（`amz.store`）不再整域落进客服剧本；
 * 2. 没剧本那句话不露内部 id、不替真环境打包票；
 * 3. 客服剧本遇到「没有真来信 + 一句查询」不再出「回复草稿（收件人待定）」。
 */
import type { RunEvent, RunRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createStubRuntime } from '../src/index.js'
import { isQueryBrief, noPlaybookAnswer, playbookOf } from '../src/runtime/playbook.js'
import { makeRequest, runAndCollect } from './helpers.js'

const clock = { now: () => '2026-10-19T04:00:00.000Z' }

/** 从快捷问题开出来的一件事：没有真来信，只有这件事的原话（source_ref 是事项）。 */
const fromPrompt = (roleId: string, prompt: string): RunRequest => {
  const base = makeRequest({ roleId, outputs: ['answer', 'draft', 'staged_change'] })
  return {
    ...base,
    context: base.context.map((c) =>
      c.kind === 'thread'
        ? {
            ...c,
            source_ref: { type: 'matter', id: 'mat_1' },
            content: { subject: prompt, participants: [], text: prompt },
          }
        : c,
    ),
  }
}

const answerOf = (events: RunEvent[]): string => {
  const done = events.find((e) => e.type === 'run.completed') as
    | { outputs: { kind: string; text?: string }[] }
    | undefined
  return done?.outputs.find((o) => o.kind === 'answer')?.text ?? ''
}
const drafted = (events: RunEvent[]): boolean => {
  const done = events.find((e) => e.type === 'run.completed') as
    | { outputs: { kind: string }[] }
    | undefined
  return (
    events.some((e) => e.type === 'change.staged' || e.type === 'proposal.created') ||
    (done?.outputs ?? []).some((o) => o.kind !== 'answer')
  )
}

describe('没剧本照实说', () => {
  it('amz.store 不走客服剧本；amz.support 照旧走', () => {
    expect(playbookOf('amz.store')).toBeUndefined()
    expect(playbookOf('amz.support')).toBe('support')
    expect(playbookOf('dtc.support')).toBe('support')
  })

  it('那句话开头就是「演示里没有这段」，不露内部 id，不说「接上真模型照常工作」', () => {
    const text = noPlaybookAnswer('site.shopify-build')
    expect(text.startsWith('演示里没有这段')).toBe(true)
    expect(text).not.toContain('site.shopify-build')
    expect(text).not.toContain('照常工作')
  })

  it('「看看我的 Listing」在 Amazon 店铺运营里不再出回信卡', async () => {
    const { events } = await runAndCollect(
      createStubRuntime({ clock }),
      fromPrompt('amz.store', '看看我的 Listing 有什么问题'),
    )
    expect(drafted(events)).toBe(false)
    expect(answerOf(events)).toContain('演示里没有这段')
  })

  it('客服里问「超时没回的来信有哪些」：不起草、不出卡，照实说', async () => {
    const { events } = await runAndCollect(
      createStubRuntime({ clock }),
      fromPrompt('dtc.support', '超过 8 小时还没回的客户来信有哪些，急的排前面'),
    )
    expect(drafted(events)).toBe(false)
    expect(answerOf(events)).toContain('演示里没有这段')
  })

  it('要写信的快捷问题照旧走剧本（起草退货回复不是查询）', () => {
    expect(
      isQueryBrief('把这封退货来信按退货政策起草一封回复，先算清楚这一单还在不在退货期内'),
    ).toBe(false)
    expect(isQueryBrief('超过 8 小时还没回的客户来信有哪些，急的排前面')).toBe(true)
    expect(isQueryBrief('现在有哪些买家消息离 24 小时只剩不到 4 小时？')).toBe(true)
  })
})

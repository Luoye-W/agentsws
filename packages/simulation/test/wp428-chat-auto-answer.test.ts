/**
 * WP428（决策 1246 改）：在线客服按置信度直接答——三个运行时同一个口径。
 *
 * - 知识库里有（保修卡）→ 直接答、不出卡；
 * - 知识库里没有（运费）→ 转人（出卡、访客那边说「稍等，马上帮你问」）；
 * - 退款 → 不管把握多高一律转人。
 */
import { CHAT_HELD_REPLY } from '@agentsws/support-core'
import { describe, expect, it, vi } from 'vitest'
import type { Evidence, RuntimeName } from '../src/index.js'
import { loadScenario, runScenario } from '../src/index.js'
import { PACK_DIR, pack } from './helpers.js'

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 })

const RUNTIMES: RuntimeName[] = ['stub', 'direct', 'dsh-in-process']

async function run(
  file: string,
  runtime: RuntimeName,
): Promise<{ passed: boolean; evidence: Evidence }> {
  let evidence: Evidence | undefined
  const report = await runScenario(loadScenario(`${PACK_DIR}/scenarios/chat/${file}`), {
    pack: pack(),
    runtime,
    captureEvidence: (e) => {
      evidence = e
    },
  })
  if (evidence === undefined) throw new Error('没有拿到证据')
  return { passed: report.passed, evidence }
}

const decisions = (evidence: Evidence): string[] =>
  evidence.events
    .filter((e) => e.type === 'simulation.chat_auto_answer')
    .map((e) => String((e.payload as { decision?: string }).decision))

describe('WP428 聊天按置信度直接答 × 三个运行时', () => {
  it('知识库有 → 直接答；没有 → 转人；退款一律转人（三个运行时一样）', async () => {
    const seen: Record<string, string> = {}
    for (const runtime of RUNTIMES) {
      const faq = await run('faq-answer-and-money-handoff.yml', runtime)
      expect(faq.passed, runtime).toBe(true)
      expect(decisions(faq.evidence), runtime).toEqual(['sent'])
      const none = await run('no-source-goes-to-human.yml', runtime)
      expect(none.passed, runtime).toBe(true)
      expect(decisions(none.evidence), runtime).toEqual(['held'])
      const held = none.evidence.events.find(
        (e) =>
          e.type === 'simulation.chat_auto_answer' &&
          (e.payload as { hold?: string }).hold === 'no_source',
      )
      expect(held, runtime).toBeDefined()
      seen[runtime] = JSON.stringify(decisions(faq.evidence).concat(decisions(none.evidence)))
    }
    expect(seen.direct).toBe(seen.stub)
    expect(seen['dsh-in-process']).toBe(seen.stub)
    expect(CHAT_HELD_REPLY).toContain('马上帮你问')
  })
})

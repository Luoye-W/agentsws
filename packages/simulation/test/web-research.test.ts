/**
 * WP179：模拟包里那条「内容与搜索上网查一次资料」——官方网页工具在三个运行时里。
 *
 * 钉三件事：
 * 1. 四个运行时（stub / direct / dsh 进程内 / dsh 子进程）走出**同一串调用**：先 `web_search` 再 `web_fetch`；
 * 2. 审计同一个口径：一次搜索一条 `web.searched`、一次抓取一条 `web.fetched`，查询 / 网址与条数相同，**没有正文**；
 * 3. 回话里列的来源网址四边相同（都来自同一个确定性的替身）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Evidence, RuntimeName } from '../src/index.js'
import { loadScenario, runScenario } from '../src/index.js'
import { PACK_DIR, pack } from './helpers.js'

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 })

const FILE = `${PACK_DIR}/scenarios/content/web-research-official-search.yml`
const RUNTIMES: RuntimeName[] = ['stub', 'direct', 'dsh-in-process', 'dsh-subprocess']

async function evidenceOf(runtime: RuntimeName): Promise<{ passed: boolean; evidence: Evidence }> {
  let evidence: Evidence | undefined
  const report = await runScenario(loadScenario(FILE), {
    pack: pack(),
    runtime,
    captureEvidence: (e) => {
      evidence = e
    },
  })
  if (evidence === undefined) throw new Error('没有拿到证据')
  return { passed: report.passed, evidence }
}

describe('WP179 content/web-research-official-search × 四个运行时', () => {
  it('同一串调用、同一份审计、同一组来源网址；没有正文进事件日志', async () => {
    const seen: Record<string, unknown> = {}
    for (const runtime of RUNTIMES) {
      const { passed, evidence } = await evidenceOf(runtime)
      expect(passed, runtime).toBe(true)
      const calls = evidence.events
        .filter((e) => e.type === 'tool.call')
        .map((e) => (e.payload as { tool: string }).tool)
      expect(calls, runtime).toEqual(['web_search', 'web_fetch'])
      const audit = evidence.events
        .filter((e) => e.type === 'web.searched' || e.type === 'web.fetched')
        .map((e) => {
          const { run_id: _r, ...rest } = e.payload as Record<string, unknown>
          return { type: e.type, ...rest }
        })
      expect(audit, runtime).toHaveLength(2)
      const run = evidence.runs.find((r) => r.request.web !== undefined)
      const answer = run?.result?.outputs.find((o) => o.kind === 'answer')
      const text = answer?.kind === 'answer' ? answer.text : ''
      // 三条来源 + "细看了第一条（…）"那一处复述；去重后是三条
      const urls = [...new Set(text.match(/https:\/\/example\.com\/[0-9a-f]{8}\/\d/g) ?? [])]
      expect(urls, runtime).toHaveLength(3)
      seen[runtime] = { audit, urls }
      // 网页正文（替身正文那一句）一个字都不在事件日志里
      expect(JSON.stringify(evidence.events), runtime).not.toContain('替身网页正文')
    }
    expect(seen.direct).toEqual(seen.stub)
    expect(seen['dsh-in-process']).toEqual(seen.stub)
    expect(seen['dsh-subprocess']).toEqual(seen.stub)
  })
})

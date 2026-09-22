/**
 * WP122b 交付 ④：成文接模型（71 §9 第 4 条）。
 *
 * 三件事各有一个 it：
 * 1. **配了模型**：`composeDesignProse` 真被调到（替身收到了只有**有证据**的小节），
 *    正文是替身写的，积分按预估记账、不超封顶；
 * 2. **没配模型**：`modelFor` 回 `undefined`，正文退回按令牌直述的那一版，
 *    版本历史里**如实标注**（"没接上模型"），不报错、不编；
 * 3. **模型炸了 / 回了读不出的东西**：也退回直述版并标注——
 *    抓取那一轮不该因为成文那一步失败就整个失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createBrandDesign, designPageKindOf } from '../src/brand-design.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string =>
  readFileSync(join(HERE, '../../..', 'packages/brand-design/test/fixtures', name), 'utf8')

const ACTOR = {
  workspace_id: 'ws_test',
  person_id: 'p_owner',
  assignment_id: 'asg_owner',
  role_id: 'common.owner',
}

function makeDesign(modelFor?: Parameters<typeof createBrandDesign>[0]['modelFor']) {
  return createBrandDesign({
    clock: { now: () => '2026-09-21T09:00:00.000Z' },
    workspace_id: 'ws_test',
    fetch: () => {
      throw new Error('这一轮不该重抓任何页面')
    },
    pages: () => [
      {
        url: 'https://heritage.test/',
        kind: designPageKindOf('https://heritage.test/'),
        html: fixture('shopify-home.html'),
        sheets: [
          {
            url: 'https://cdn.shopify.com/s/files/1/0001/theme.css',
            css: fixture('shopify-theme.css'),
          },
        ],
      },
    ],
    newId: (prefix) => `${prefix}_1`,
    ...(modelFor === undefined ? {} : { modelFor }),
  })
}

/** 捕捉替身收到了什么，并回一段分好节的正文。 */
function stubModel(markdown: string) {
  const calls: { prompt: string; tier: string; purpose: string }[] = []
  const model = async (req: { prompt: string; tier: 'cheap'; purpose: string }) => {
    calls.push(req)
    return { text: markdown }
  }
  return { calls, model }
}

describe('WP122b ④：成文接模型', () => {
  it('配了模型：只有有证据的小节进提示词，正文是模型写的，积分记账不超封顶', async () => {
    const stub = stubModel('## Colors\n\n绿是主色，用来按钮。\n\n## Typography\n\n标题用 Inter。\n')
    const design = makeDesign(({ actor, run_id }) => {
      expect(actor.role_id).toBe('common.owner')
      expect(run_id).toContain('bdr')
      return stub.model
    })
    const run = await design.port.extract(ACTOR, {})
    expect(stub.calls.length).toBe(1)
    expect(stub.calls[0]?.tier).toBe('cheap')
    // 只根据证据写：抓到了色与字体，提示词里就有；间距没抓到，就进不去
    expect(stub.calls[0]?.prompt).toContain('## Colors')
    expect(stub.calls[0]?.prompt).toContain('## Typography')
    expect(stub.calls[0]?.prompt).not.toContain('## Layout')
    // 正文是模型写的
    const doc = design.port.get(ACTOR)
    expect(doc?.markdown).toContain('绿是主色，用来按钮')
    // 积分：预估 0.3（一次便宜档调用，没有视觉调用），封顶 1，实花 0.3
    expect(run.budget.estimated_credits).toBe(0.3)
    expect(run.budget.cap_credits).toBe(1)
    expect(run.budget.spent_credits).toBe(0.3)
    expect(run.status).toBe('awaiting_confirm')
    design.close()
  })

  it('没配模型：退回直述版，版本历史如实标注，不报错', async () => {
    const design = makeDesign(() => undefined)
    const run = await design.port.extract(ACTOR, {})
    expect(run.status).toBe('awaiting_confirm')
    const doc = design.port.get(ACTOR)
    expect(doc?.markdown).toContain('#b8422e') // 直述：原值都在
    const revisions = design.port.revisions(ACTOR)
    expect(revisions.at(-1)?.note).toContain('没接上模型')
    expect(run.budget.spent_credits).toBe(0)
    design.close()
  })

  it('模型炸了：退回直述版并标注，整轮抓取不失败', async () => {
    const design = makeDesign(() => async () => {
      throw new Error('上游 500')
    })
    const run = await design.port.extract(ACTOR, {})
    expect(run.status).toBe('awaiting_confirm')
    const doc = design.port.get(ACTOR)
    expect(doc?.markdown).toContain('#b8422e')
    expect(design.port.revisions(ACTOR).at(-1)?.note).toContain('模型没回')
    design.close()
  })
})

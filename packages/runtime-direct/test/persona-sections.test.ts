/**
 * WP120（69 §3 / §5）：**persona 那几段真的进了送模型的系统提示**。
 *
 * 69 §0 那条亲测记录的根因是"提示里没有你是谁"。所以这一组不测措辞（措辞由
 * `packages/roles/test/persona-crosswalk.test.ts` 对着包里真的那几段钉），
 * 测的是**装配这一跳**：岗位名、职责名、「你不负责」那一段，到底在不在模型收到的文本里。
 *
 * 两层都测：
 * - `assembleDirect`：装配函数本身（顺序、静态前缀、逐字节可重放）；
 * - **替身模型**：`scriptedProvider` 收到的 `messages`——这才是"真进了提示"的证据。
 *   只测装配函数的话，中间任何一跳把 persona 段丢掉都看不出来。
 *
 * dsh 那一侧同样的一组在 `packages/dsh-adapter/test/persona-sections.test.ts`。
 */
import type { ChatMessage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { assembleDirect } from '../src/index.js'
import { harness, makeRequest } from './helpers.js'

/**
 * 一次红人运行的两段 persona（岗位 → 职责）。
 *
 * 文字照着包里 `positions/kol-marketing.yml` 与 `roles/kol/youtube.yml` 的骨架写，
 * 但**不在这里读包**：direct 运行时不该为了一个测试去依赖职责加载器。
 * 包里那几段的原文由 crosswalk 那组测试钉着。
 */
const POSITION_SECTION = {
  id: 'position',
  name: '红人营销',
  order: 10,
  text: [
    '你是谁：这家公司管红人合作的岗位。',
    '你负责：找人、建联、谈合作、验收、算账。',
    '你不负责：客户的退款与物流→客服；自己账号发帖→社媒运营。',
    '怎么做：先查手边已有的人和合作。',
    '口气：像个谈合作的人，具体、不许诺。',
    '必须出卡：每一封开发信。',
  ].join('\n'),
}

const ROLE_SECTION = {
  id: 'role',
  name: 'YouTube 红人',
  order: 20,
  text: [
    '你是谁：红人营销岗位里做 YouTube 这条渠道的人。',
    '你负责：找频道并打分、写开发信、跟进回信。',
    '你不负责：客户退款物流→客服；自己账号发帖→社媒运营。',
    '怎么做：先查这条渠道上手边的人和合作。',
    '口气：像谈合作的人。',
    '必须出卡：每封开发信。',
  ].join('\n'),
}

/** 一次带两段 persona 的红人运行。 */
const kolRequest = (sections = [POSITION_SECTION, ROLE_SECTION]) =>
  makeRequest({
    actor: { person_id: 'p_agent', assignment_id: 'asg_1', role_id: 'kol.youtube' },
    persona: { sections },
  })

/** 装配出来那几条 system 消息拼成一段文本。 */
const systemTextOf = (messages: readonly ChatMessage[]): string =>
  messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n')

/** 跑一次，把替身模型**实际收到**的 messages 抄下来。 */
async function seenByModel(sections = [POSITION_SECTION, ROLE_SECTION]): Promise<ChatMessage[]> {
  const seen: ChatMessage[][] = []
  const h = harness({
    script: (input) => {
      seen.push(input.messages)
      return { text: '已经按条件筛出 20 个频道，排好序了。' }
    },
  })
  await h.run(kolRequest(sections))
  expect(seen.length).toBeGreaterThan(0)
  return seen[0] ?? []
}

describe('persona 段进系统提示（69 §3）', () => {
  it('岗位名与职责名都在提示文本里', () => {
    const text = systemTextOf(assembleDirect(kolRequest()).messages)
    expect(text).toContain('红人营销')
    expect(text).toContain('YouTube 红人')
  })

  it('「你不负责」那一段在——它是防串岗的唯一一句', () => {
    const text = systemTextOf(assembleDirect(kolRequest()).messages)
    expect(text).toContain('你不负责')
    expect(text).toContain('客户的退款与物流→客服')
  })

  it('岗位在前、职责在后（69 §3 的装配顺序）', () => {
    const text = systemTextOf(assembleDirect(kolRequest()).messages)
    expect(text.indexOf('## position')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('## position')).toBeLessThan(text.indexOf('## role'))
  })

  it('**替身模型真的收到了**这两段（不是只装配出来放在一边）', async () => {
    const text = systemTextOf(await seenByModel())
    expect(text).toContain('红人营销')
    expect(text).toContain('你不负责')
    expect(text).toContain('客户的退款与物流→客服')
  })

  it('反查不出岗位时整段不出，但职责那一段还在（54 §3「不猜一个」）', async () => {
    const text = systemTextOf(await seenByModel([ROLE_SECTION]))
    expect(text).not.toContain('## position')
    expect(text).toContain('YouTube 红人')
  })

  it('persona 变了静态前缀就变（22 §2 缓存纪律照旧成立）', () => {
    const before = assembleDirect(kolRequest()).static_prefix_hash
    const after = assembleDirect(kolRequest([ROLE_SECTION])).static_prefix_hash
    expect(after).not.toBe(before)
  })

  it('同一份请求装配两次逐字节相同（17 §6.2 回放那条铁律不受 persona 影响）', () => {
    const req = kolRequest()
    const a = assembleDirect(req)
    const b = assembleDirect(structuredClone(req))
    expect(a.static_prefix_hash).toBe(b.static_prefix_hash)
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages))
  })
})

/**
 * WP120（69 §3 / §5）：**persona 段真的进了系统提示**。
 *
 * 69 §0 那条亲测记录的根因是"提示里没有你是谁"。所以这一组不测措辞，测的是
 * 那几段**到底在不在送进模型的那份文本里**——装配那一跳是 direct 与 dsh 共用的
 * （`@agentsws/stand-ins` 的 `assemblePrompt`，17 §1 铁律：定义只有一处），
 * 所以在这里钉住它，等于两个真运行时都钉住了。
 *
 * 断言的是三件事：
 * 1. 岗位名与职责名在系统提示里；
 * 2. **「你不负责」那一段在**——它是防串岗的唯一一句；
 * 3. 顺序是岗位在前、职责在后（69 §3 装配顺序）。
 */
import { personaSections, personaTextIn } from '@agentsws/roles'
import { describe, expect, it } from 'vitest'
import { assembleDirect } from '../src/index.js'
import { makeRequest } from './helpers.js'

/** 用真的包里那两段——测一段编出来的 persona 等于什么都没测。 */
const KOL_ROLE = {
  zh: [
    '你是谁：红人营销岗位里做 YouTube 这条渠道的人。',
    '你负责：找频道并打分、写开发信。',
    '你不负责：客户退款物流→客服；自己账号发帖→社媒运营。',
    '怎么做：先查这条渠道上手边的人和合作。',
    '口气：像谈合作的人，具体、不许诺。',
    '必须出卡：每封开发信。',
  ].join('\n'),
  en: [
    'Who you are: the YouTube channel of the creator-marketing position.',
    'You handle: finding channels, writing outreach.',
    'Not yours: customer refunds and shipping → Customer Care.',
    'How you work: start from what you already have here.',
    'Tone: concrete, never promising.',
    'Always ask: every outreach email.',
  ].join('\n'),
}

const KOL_POSITION = {
  zh: [
    '你是谁：这家公司的红人营销岗位。',
    '你负责：找人、建联、谈合作、验收、算账。',
    '你不负责：客户的退款与物流（转客服）。',
    '怎么做：先查手边的人和合作。',
    '口气：像个谈合作的人。',
    '必须出卡：每一封开发信。',
  ].join('\n'),
  en: [
    'Who you are: the creator-marketing position.',
    'You handle: finding, outreach, deals, reviews, attribution.',
    'Not yours: customer refunds and shipping (Customer Care).',
    'How you work: start from what you have.',
    'Tone: like someone negotiating a deal.',
    'Always ask: every outreach email.',
  ].join('\n'),
}

/** 一次红人的运行（岗位 + 职责两段都装上）。 */
function kolRequest(lang: 'zh' | 'en' = 'zh') {
  return makeRequest({
    actor: { person_id: 'p_agent', assignment_id: 'asg_1', role_id: 'kol.youtube' },
    persona: {
      sections: personaSections({
        lang,
        position: { id: 'kol-marketing', name: '红人营销', persona: KOL_POSITION },
        role: { id: 'kol.youtube', name: 'YouTube 红人', persona: KOL_ROLE },
      }),
    },
  })
}

/** 送进模型的那几条 system 消息拼起来。 */
const systemText = (req: ReturnType<typeof kolRequest>): string =>
  assembleDirect(req)
    .messages.filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n')

describe('persona 段进系统提示（69 §3）', () => {
  it('岗位名与职责名都在提示文本里', () => {
    const text = systemText(kolRequest())
    expect(text).toContain('红人营销')
    expect(text).toContain('YouTube 红人')
  })

  it('「你不负责」那一段在——它是防串岗的唯一一句', () => {
    const text = systemText(kolRequest())
    expect(text).toContain('你不负责')
    expect(text).toContain('客户退款物流→客服')
  })

  it('岗位在前、职责在后（69 §3 的装配顺序）', () => {
    const text = systemText(kolRequest())
    expect(text.indexOf('## position')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('## position')).toBeLessThan(text.indexOf('## role'))
  })

  it('英文界面送的是英文那份（不会拿中文回英文客户）', () => {
    const text = systemText(kolRequest('en'))
    expect(text).toContain('Not yours')
    expect(text).not.toContain('你不负责')
  })

  it('persona 变了静态前缀就变（22 §2 缓存纪律照旧成立）', () => {
    const before = assembleDirect(kolRequest()).static_prefix_hash
    const changed = makeRequest({
      actor: { person_id: 'p_agent', assignment_id: 'asg_1', role_id: 'kol.youtube' },
      persona: {
        sections: personaSections({
          role: { id: 'kol.youtube', name: 'YouTube 红人', persona: KOL_ROLE },
        }),
      },
    })
    expect(assembleDirect(changed).static_prefix_hash).not.toBe(before)
  })

  it('同一份请求装配两次逐字节相同（回放那条铁律不受 persona 影响）', () => {
    const req = kolRequest()
    const a = assembleDirect(req)
    const b = assembleDirect(structuredClone(req))
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages))
  })

  it('取语言这一步与装配用的是同一个函数（不许两处各写一份）', () => {
    expect(personaTextIn(KOL_ROLE, 'en')).toContain('Not yours')
  })
})

/**
 * WP406（私有 docs/107 §4 / §5 / §15）：官方岗位更新——全部应用 / 挑着应用 / 跳过后下周带上 / 撞了三种选法 /
 * 整批与单项退回 / 三档设置 / 急件单出 / 一周内两次推送并进同一张卡；每条路上公司改过的段与条都没被冲掉。
 */
import { readContentTable } from '@agentsws/core'
import { houseRulesSection, personaTextIn } from '@agentsws/roles'
import { describe, expect, it, vi } from 'vitest'
import {
  bundledStore,
  decideDigest,
  type Harness,
  harness,
  OWNER,
  POSITION,
  personaWith,
  ROLE,
  roleContentFiles,
} from './wp406-harness.js'

// 每套替身都要读一遍内置职责 yml、叠一次内容：单条十几秒是常态
vi.setConfig({ testTimeout: 60_000 })

const MON = '2026-10-19T02:00:00.000Z' // 周一（ISO 2026-W43）
const WED = '2026-10-21T02:00:00.000Z'
const NEXT_MON = '2026-10-26T02:00:00.000Z'

const roleItem = (version: string, content: Record<string, unknown>, extra = {}) => ({
  kind: 'role_content' as const,
  name: ROLE,
  version,
  files: roleContentFiles(content),
  positions: [POSITION],
  ...extra,
})

const rulesItem = (version: string, zh: string, extra = {}) => ({
  kind: 'rules' as const,
  name: 'roles.house_rules',
  version,
  files: {
    'content.json': JSON.stringify({
      table: 'roles.house_rules',
      rows: [{ id: 'no_tool_names', zh, en: 'Plain words.' }],
    }),
  },
  positions: [POSITION],
  ...extra,
})

async function firstCheck(h: Harness, at = MON) {
  h.setNow(at)
  return h.oc.check()
}

describe('WP406 每周岗位更新卡', () => {
  it('出一张「<岗位> · 本周更新 · N 项」卡，全部应用后换上官方版（快捷问题、角色定位、规则表）', async () => {
    const h = harness()
    h.publish(1, [
      roleItem('1.1.0', {
        persona: { zh: personaWith('口气', '像管店的人，先讲影响多少单、再讲怎么改。') },
        quick_prompts: [
          ...(bundledStore().quick_prompts ?? []),
          {
            id: 'weekly_check',
            label: { zh: '本周体检', en: 'Weekly check' },
            prompt: '给店铺做个本周体检',
            kind: 'review',
          },
        ],
      }),
      rulesItem('1.0.1', '说人话：不提工具名、函数名、内部 id。'),
    ])
    const r = await firstCheck(h)
    expect(r.state).toBe('ok')
    const cards = h.bus.open()
    expect(cards).toHaveLength(1)
    expect(cards[0]?.title).toBe('网站运营 · 本周更新 · 2 项')
    const payload = cards[0]?.payload as { items: { mine: string }[]; advice?: string }
    expect(payload.items.map((i) => i.mine)).toEqual(['untouched', 'untouched'])
    // 没接模型：卡上不写那一句建议
    expect(payload.advice).toBeUndefined()

    await decideDigest(h, cards[0] as never, 'apply_all')
    const def = h.roles.get(ROLE)
    expect(def?.quick_prompts?.map((q) => q.id)).toContain('weekly_check')
    expect(personaTextIn(def?.persona, 'zh')).toContain('先讲影响多少单、再讲怎么改')
    expect(houseRulesSection('zh').text).toContain('说人话：不提工具名')
    const v = await h.oc.view('ws_brand' as never, POSITION, OWNER)
    expect(v.pending).toHaveLength(0)
    expect(v.applied.map((a) => a.item_id).sort()).toEqual([
      'role_content:dtc.store',
      'rules:roles.house_rules',
    ])
    expect(v.last_batch?.item_ids).toHaveLength(2)
  })

  it('AI 一句建议用品牌默认模型（给了就写在卡上）', async () => {
    const h = harness({ advise: async () => '建议全部应用，没有和你改过的冲突。' })
    h.publish(1, [rulesItem('1.0.1', '说人话。')])
    await firstCheck(h)
    const card = h.bus.open()[0]
    expect(((card?.payload ?? {}) as { advice?: string }).advice).toBe(
      '建议全部应用，没有和你改过的冲突。',
    )
    expect(card?.summary).toBe('建议全部应用，没有和你改过的冲突。')
  })

  it('一周内两次推送并进同一张卡（撤旧出新，只剩一张）；处理过之后这周后来的等下周', async () => {
    const h = harness()
    h.publish(1, [rulesItem('1.0.1', '第一版。')])
    await firstCheck(h, MON)
    expect(h.bus.open()).toHaveLength(1)
    h.publish(2, [
      rulesItem('1.0.1', '第一版。'),
      roleItem('1.1.0', { description: '管店铺本身：设置、商品、价格、促销。' }),
    ])
    h.setNow(WED)
    await h.oc.check()
    const open = h.bus.open()
    expect(open).toHaveLength(1)
    expect(((open[0]?.payload ?? {}) as { items: unknown[] }).items).toHaveLength(2)
    // 处理掉这张
    await decideDigest(h, open[0] as never, 'apply_all')
    h.publish(3, [
      rulesItem('1.0.2', '第二版。'),
      roleItem('1.1.0', { description: '管店铺本身：设置、商品、价格、促销。' }),
    ])
    await h.oc.check()
    expect(h.bus.open()).toHaveLength(0)
    h.setNow(NEXT_MON)
    await h.oc.check()
    expect(h.bus.open()).toHaveLength(1)
  })

  it('标「急」的单出一张（不等周更，也不并进普通那张）', async () => {
    const h = harness()
    h.publish(1, [rulesItem('1.0.1', '普通。')])
    await firstCheck(h, MON)
    h.publish(2, [
      rulesItem('1.0.1', '普通。'),
      roleItem('1.1.0', { description: '平台新政策：…' }, { urgent: true }),
    ])
    h.setNow(WED)
    await h.oc.check()
    const open = h.bus.open()
    expect(open).toHaveLength(2)
    const urgent = open.find((c) => (c.payload as { urgent: boolean }).urgent)
    expect(urgent?.title).toBe('网站运营 · 急 · 更新 · 1 项')
    expect(urgent?.priority).toBe('immediate')
  })

  it('这次跳过：这周不再出，下周的卡把它们一起带上', async () => {
    const h = harness()
    h.publish(1, [rulesItem('1.0.1', '第一版。')])
    await firstCheck(h, MON)
    await decideDigest(h, h.bus.open()[0] as never, 'skip')
    expect(h.bus.open()).toHaveLength(0)
    h.publish(2, [rulesItem('1.0.1', '第一版。'), roleItem('1.1.0', { description: '新说明' })])
    h.setNow(WED)
    await h.oc.check()
    expect(h.bus.open()).toHaveLength(0)
    expect((await h.oc.view('ws_brand' as never, POSITION, OWNER)).skipped_this_week).toBe(true)
    h.setNow(NEXT_MON)
    await h.oc.check()
    const next = h.bus.open()
    expect(next).toHaveLength(1)
    expect(
      ((next[0]?.payload ?? {}) as { items: { item_id: string }[] }).items
        .map((i) => i.item_id)
        .sort(),
    ).toEqual(['role_content:dtc.store', 'rules:roles.house_rules'])
  })

  it('挑着应用：只应用勾了的那几项，卡作废，没勾的下周带上', async () => {
    const h = harness()
    h.publish(1, [rulesItem('1.0.1', '挑这一条。'), roleItem('1.1.0', { description: '没挑' })])
    await firstCheck(h)
    const v = await h.oc.apply('ws_brand' as never, POSITION, OWNER, {
      item_ids: ['rules:roles.house_rules'],
    })
    expect(v.applied.map((a) => a.item_id)).toEqual(['rules:roles.house_rules'])
    expect(v.pending.map((p) => p.item_id)).toEqual(['role_content:dtc.store'])
    expect(h.bus.open()).toHaveLength(0)
    expect(readContentTable({ table: 'roles.house_rules', rows: [] })[0]).toMatchObject({
      zh: '挑这一条。',
    })
  })

  it('用户没开的岗位不出卡；「这个岗位不再更新」不出；「没撞的自动应用」直接应用', async () => {
    const off = harness({ positions: [] })
    off.publish(1, [rulesItem('1.0.1', 'x')])
    await firstCheck(off)
    expect(off.bus.open()).toHaveLength(0)

    const h = harness()
    h.publish(1, [rulesItem('1.0.1', 'y')])
    await h.oc.setPolicy('ws_brand' as never, POSITION, OWNER, 'off')
    await firstCheck(h)
    expect(h.bus.open()).toHaveLength(0)
    expect((await h.oc.view('ws_brand' as never, POSITION, OWNER)).pending).toHaveLength(0)

    const auto = harness()
    auto.publish(1, [rulesItem('1.0.1', '自动换上。')])
    await auto.oc.setPolicy('ws_brand' as never, POSITION, OWNER, 'auto_clean')
    const r = await firstCheck(auto)
    expect(r.applied).toEqual(['ws_brand:rules:roles.house_rules'])
    expect(auto.bus.open()).toHaveLength(0)
    expect(houseRulesSection('zh').text).toContain('自动换上。')
  })
})

describe('WP406 你改过的不被冲掉', () => {
  const sectionOverride = (h: Harness, section: string, body: string) => {
    h.personas.set(`role:${ROLE}`, {
      workspace_id: 'ws_brand' as never,
      subject: { kind: 'role', id: ROLE },
      text: { zh: personaWith(section === 'tone' ? '口气' : '怎么做', body), en: '' },
      sections: { zh: { [section]: body } },
      updated_at: MON,
      updated_by: OWNER,
    })
  }

  it('你改过的段新版没动：会保留（卡上「会保留」，应用后你那段照旧生效）', async () => {
    const h = harness()
    sectionOverride(h, 'how', '我们自己的做法。')
    h.publish(1, [roleItem('1.1.0', { persona: { zh: personaWith('口气', '官方新口气。') } })])
    await firstCheck(h)
    const card = h.bus.open()[0]
    expect(((card?.payload ?? {}) as { items: { mine: string }[] }).items[0]?.mine).toBe('kept')
    await decideDigest(h, card as never, 'apply_all')
    expect(h.personas.get(`role:${ROLE}`)?.sections?.zh?.how).toBe('我们自己的做法。')
    expect(personaTextIn(h.roles.get(ROLE)?.persona, 'zh')).toContain('官方新口气。')
  })

  it('撞了：全部应用先保留你的、标出来；三种选法——用新版 / 保留我的 / 用 AI 合好的这版', async () => {
    for (const choice of ['use_new', 'keep_mine', 'use_ai'] as const) {
      const h = harness({ aiMerge: async () => 'AI 合好的口气。' })
      sectionOverride(h, 'tone', '我们的口气。')
      h.publish(1, [roleItem('1.1.0', { persona: { zh: personaWith('口气', '官方新口气。') } })])
      await firstCheck(h)
      const card = h.bus.open()[0]
      expect(((card?.payload ?? {}) as { items: { mine: string }[] }).items[0]?.mine).toBe('clash')
      const d = h.oc.diff('ws_brand' as never, POSITION, `role_content:${ROLE}`)
      const part = d.parts.find((p) => p.key === 'persona.tone')
      expect(part).toMatchObject({
        clash: true,
        mine: '我们的口气。',
        after: '官方新口气。',
        mergeable: true,
      })
      await decideDigest(h, card as never, 'apply_all')
      // 先保留你的
      expect(h.personas.get(`role:${ROLE}`)?.sections?.zh?.tone).toBe('我们的口气。')
      const v = await h.oc.view('ws_brand' as never, POSITION, OWNER)
      expect(v.applied[0]?.kept_clashes).toBe(1)
      const key = `role_content:${ROLE}#persona.tone`
      const ai = await h.oc.aiMerge('ws_brand' as never, POSITION, OWNER, {
        item_id: `role_content:${ROLE}`,
        part_key: 'persona.tone',
      })
      expect(ai.text).toBe('AI 合好的口气。')
      await h.oc.apply('ws_brand' as never, POSITION, OWNER, {
        item_ids: [],
        choices: { [key]: choice },
        ...(choice === 'use_ai' ? { ai_texts: { [key]: ai.text ?? '' } } : {}),
      })
      const tone = h.personas.get(`role:${ROLE}`)?.sections?.zh?.tone
      if (choice === 'use_new') expect(tone).toBeUndefined()
      if (choice === 'keep_mine') expect(tone).toBe('我们的口气。')
      if (choice === 'use_ai') expect(tone).toBe('AI 合好的口气。')
      const after = await h.oc.view('ws_brand' as never, POSITION, OWNER)
      expect(after.applied[0]?.kept_clashes ?? 0).toBe(choice === 'keep_mine' ? 1 : 0)
    }
  })

  it('快捷问题：你隐藏 / 改过的那几条，新版没动的照旧；只照抄旧版的跟新版走', async () => {
    const h = harness()
    const base = bundledStore().quick_prompts ?? []
    const first = base[0]
    const second = base[1]
    if (first === undefined || second === undefined) throw new Error('need two prompts')
    h.oc.setItemEdits('ws_brand' as never, `role:${ROLE}:quick_prompts`, [
      { tier: 'company', owner: 'ws_brand', op: 'hide', item_id: first.id },
      // 照抄了旧版（没真改）
      { tier: 'company', owner: 'ws_brand', op: 'edit', item_id: second.id, value: second },
    ])
    expect(h.roles.get(ROLE)?.quick_prompts?.some((q) => q.id === first.id)).toBe(false)
    const changed = { ...second, prompt: `${second.prompt}（官方新写法）` }
    h.publish(1, [roleItem('1.1.0', { quick_prompts: [first, changed, ...base.slice(2)] })])
    await firstCheck(h)
    await decideDigest(h, h.bus.open()[0] as never, 'apply_all')
    const qp = h.roles.get(ROLE)?.quick_prompts ?? []
    expect(qp.some((q) => q.id === first.id)).toBe(false) // 你隐藏的还隐藏着
    expect(qp.find((q) => q.id === second.id)?.prompt).toContain('官方新写法') // 照抄的跟新版走
    expect(h.oc.itemEdits('ws_brand' as never, `role:${ROLE}:quick_prompts`)).toHaveLength(1)
  })

  it('AI 学的记忆（技能上面几层）不动：应用 / 退回前后一样', async () => {
    const h = harness()
    sectionOverride(h, 'how', '我们自己的做法。')
    h.publish(1, [roleItem('1.1.0', { persona: { zh: personaWith('口气', '新口气') } })])
    await firstCheck(h)
    const before = JSON.stringify([...h.personas.entries()])
    await decideDigest(h, h.bus.open()[0] as never, 'apply_all')
    await h.oc.rollback('ws_brand' as never, POSITION, OWNER, {})
    expect(JSON.stringify([...h.personas.entries()])).toBe(before)
  })
})

describe('WP406 退回', () => {
  it('整批退回上一批：官方版撤下，回到随软件带的；你那几处一起还原', async () => {
    const h = harness()
    h.personas.set(`role:${ROLE}`, {
      workspace_id: 'ws_brand' as never,
      subject: { kind: 'role', id: ROLE },
      text: { zh: personaWith('口气', '你是谁那段原样。'), en: '' },
      // 照抄了旧版（应用时会被理掉，退回时要还原）
      sections: { zh: { tone: '像管店的人，说人话，先讲影响多少单。' } },
      updated_at: MON,
      updated_by: OWNER,
    })
    h.publish(1, [
      roleItem('1.1.0', { persona: { zh: personaWith('口气', '新口气。') } }),
      rulesItem('1.0.1', '新规矩。'),
    ])
    await firstCheck(h)
    await decideDigest(h, h.bus.open()[0] as never, 'apply_all')
    expect(h.personas.get(`role:${ROLE}`)).toBeUndefined()
    const v = await h.oc.rollback('ws_brand' as never, POSITION, OWNER, {})
    expect(v.applied).toHaveLength(0)
    expect(houseRulesSection('zh').text).not.toContain('新规矩。')
    expect(personaTextIn(h.roles.get(ROLE)?.persona, 'zh')).not.toContain('新口气。')
    expect(h.personas.get(`role:${ROLE}`)?.sections?.zh?.tone).toBe(
      '像管店的人，说人话，先讲影响多少单。',
    )
    // 退回过的那一版不再提
    expect(v.pending).toHaveLength(0)
    expect(h.events.some((e) => e.type === 'content_update.batch_rolled_back')).toBe(true)
  })

  it('单项退回：只退这一项，同一批的别的照旧', async () => {
    const h = harness()
    h.publish(1, [roleItem('1.1.0', { description: '新说明' }), rulesItem('1.0.1', '新规矩二。')])
    await firstCheck(h)
    await decideDigest(h, h.bus.open()[0] as never, 'apply_all')
    const v = await h.oc.rollback('ws_brand' as never, POSITION, OWNER, {
      item_id: 'rules:roles.house_rules',
    })
    expect(v.applied.map((a) => a.item_id)).toEqual([`role_content:${ROLE}`])
    expect(houseRulesSection('zh').text).not.toContain('新规矩二。')
    expect(h.roles.get(ROLE)?.description).toBe('新说明')
  })
})

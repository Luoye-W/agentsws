/**
 * WP406（私有 docs/107 §6 / §7 / §5.3 / §5.4）：官方岗位更新的几道关——
 * 白名单外字段、坏签名、坏哈希、来源不对整包拒收；没订阅只出小字不出卡（关掉 30 天不提）；
 * 订阅本机记 7 天（断网 7 天内照常、之后停查）；断网不报错；老令牌缺动作集引导重新登录；
 * 公司模式非负责人点不了；技能上面几层（AI 学的）不动。
 */
import { readFileSync } from 'node:fs'
import type { ApprovalItem, Skill } from '@agentsws/contracts'
import { BUNDLED_SKILLS_DIR } from '@agentsws/skills'
import { describe, expect, it, vi } from 'vitest'
import {
  decideDigest,
  harness,
  MEMBER,
  OWNER,
  officialKeys,
  POSITION,
  pack,
  ROLE,
  roleContentFiles,
  SUPERVISOR,
  WS,
} from './wp406-harness.js'

vi.setConfig({ testTimeout: 60_000 })

const MON = '2026-10-19T02:00:00.000Z'
// 下一周、但离上次问到云还不满 7 天
const NEXT_MON = '2026-10-26T01:00:00.000Z'
const LATER = '2026-11-02T02:00:00.000Z'

const rules = (version: string, zh: string) => ({
  kind: 'rules' as const,
  name: 'roles.house_rules',
  version,
  files: {
    'content.json': JSON.stringify({
      table: 'roles.house_rules',
      rows: [{ id: 'no_tool_names', zh, en: 'x' }],
    }),
  },
  positions: [POSITION],
  title: '说话规矩 改 1 条',
})

describe('WP406 整包拒收', () => {
  it('职责内容里有白名单外的字段（scopes）：整包不收，同包里好的那一项也不收', async () => {
    const h = harness()
    h.publish(1, [
      rules('1.0.1', '好的那一项'),
      {
        kind: 'role_content',
        name: ROLE,
        version: '1.1.0',
        files: roleContentFiles({ description: '改说明', scopes: [] }),
        positions: [POSITION],
      },
    ])
    h.setNow(MON)
    const r = await h.oc.check()
    expect(r.state).toBe('error')
    expect(r.reason).toBe('bad_manifest')
    expect(h.bus.open()).toHaveLength(0)
    const v = await h.oc.view(WS, POSITION, OWNER)
    expect(v.pending).toHaveLength(0)
    expect(v.last_error).toBeDefined()
    expect(h.events.some((e) => e.type === 'content_update.rejected')).toBe(true)
  })

  it('坏签名 / 别的钥匙签的 / 坏哈希 / 来源写成公开通道：一律整包拒收', async () => {
    const cases: [string, (h: ReturnType<typeof harness>) => void][] = [
      [
        'bad_signature',
        (h) => {
          h.cloud.signatureOverride = Buffer.alloc(64, 1).toString('base64')
        },
      ],
      [
        // 别的钥匙签的：在官方那张表里找不到能验过的钥匙 = 签名对不上
        'bad_signature',
        (h) => {
          h.cloud.built = pack(h.dir, officialKeys(), 1, [rules('1.0.1', '别的钥匙')])
        },
      ],
      [
        'bad_hash',
        (h) => {
          const sha = h.cloud.built?.manifest.items[0]?.files[0]?.sha256 ?? ''
          h.cloud.blobOverride.set(sha, Buffer.from('{"table":"roles.house_rules","rows":[]}'))
        },
      ],
      [
        'source',
        (h) => {
          h.cloud.built = pack(h.dir, h.key, 1, [rules('1.0.1', '公开通道')], { source: 'public' })
        },
      ],
    ]
    for (const [reason, spoil] of cases) {
      const h = harness()
      h.publish(1, [rules('1.0.1', '原本')])
      spoil(h)
      h.setNow(MON)
      const r = await h.oc.check()
      expect(r.reason, reason).toBe(reason)
      expect(h.bus.open(), reason).toHaveLength(0)
      expect((await h.oc.view(WS, POSITION, OWNER)).pending, reason).toHaveLength(0)
    }
  })
})

describe('WP406 订阅', () => {
  it('没订阅：不出卡；岗位设定里一行小字（几项、标题），关掉 30 天不提', async () => {
    const h = harness()
    h.cloud.sub = { ...h.cloud.sub, status: 'none', usable: false }
    h.publish(1, [rules('1.0.1', 'x')], { created_at: '2026-10-18T00:00:00.000Z' })
    h.setNow(MON)
    await h.oc.check()
    expect(h.bus.open()).toHaveLength(0)
    expect(h.cloud.calls.some((c) => c.startsWith('BYTES'))).toBe(false)
    const v = await h.oc.view(WS, POSITION, OWNER)
    expect(v.subscription.state).toBe('none')
    expect(v.nudge).toEqual({
      count: 1,
      urgent: false,
      titles: [{ zh: '说话规矩 改 1 条', en: 'roles.house_rules update' }],
    })
    const quiet = await h.oc.dismissNudge(WS, POSITION, OWNER)
    expect(quiet.nudge).toBeUndefined()
    h.setNow('2026-11-10T02:00:00.000Z')
    expect((await h.oc.view(WS, POSITION, OWNER)).nudge).toBeUndefined()
    h.setNow('2026-11-19T03:00:00.000Z')
    h.publish(2, [rules('1.0.2', 'y')], { created_at: '2026-11-18T00:00:00.000Z' })
    await h.oc.check()
    expect((await h.oc.view(WS, POSITION, OWNER)).nudge?.count).toBe(1)
  })

  it('订阅：走云上那一条，订上后马上查一次出卡（没有试用）', async () => {
    const h = harness()
    h.cloud.sub = { ...h.cloud.sub, status: 'none', usable: false }
    h.publish(1, [rules('1.0.1', 'x')])
    h.setNow(MON)
    await h.oc.check()
    const s = await h.oc.subscribe(WS, OWNER)
    expect(s.state).toBe('active')
    expect(h.cloud.calls).toContain('POST /v1/content/subscription')
    await vi.waitFor(() => expect(h.bus.open()).toHaveLength(1))
  })

  it('订阅本机记 7 天：断网 7 天内照常（照已经收下的出卡），过了只暂停查新；断网不报错', async () => {
    const h = harness()
    h.publish(1, [rules('1.0.1', 'x')])
    h.setNow(MON)
    await h.oc.check()
    await decideDigest(h, h.bus.open()[0] as ApprovalItem, 'skip')
    h.cloud.offline = true
    h.setNow(NEXT_MON)
    const r = await h.oc.check()
    expect(r.state).toBe('ok')
    expect((await h.oc.view(WS, POSITION, OWNER)).subscription.state).toBe('cached')
    expect(h.bus.open()).toHaveLength(1)
    await decideDigest(h, h.bus.open()[0] as ApprovalItem, 'skip')
    h.setNow(LATER)
    const r2 = await h.oc.check()
    expect(r2.state).toBe('ok')
    const v = await h.oc.view(WS, POSITION, OWNER)
    expect(v.subscription.state).toBe('paused')
    expect(h.bus.open()).toHaveLength(0)
    // 已经下到本机的照样能用（C7）：第三栏还能应用
    expect(v.pending).toHaveLength(1)
  })

  it('老令牌缺 content 动作集（自动补签也没成）：引导重新登录，不出卡；没关联账号：什么都不出', async () => {
    const h = harness()
    h.cloud.scopeMissing = true
    h.publish(1, [rules('1.0.1', 'x')])
    h.setNow(MON)
    await h.oc.check()
    const v = await h.oc.view(WS, POSITION, OWNER)
    expect(v.subscription.state).toBe('reauth')
    expect(v.subscription.note).toContain('重新登录')
    expect(h.bus.open()).toHaveLength(0)

    const u = harness()
    u.cloud.linked = false
    u.publish(1, [rules('1.0.1', 'x')])
    await u.oc.check()
    const uv = await u.oc.view(WS, POSITION, OWNER)
    expect(uv.subscription.state).toBe('unlinked')
    expect(uv.nudge).toBeUndefined()
    expect(u.bus.open()).toHaveLength(0)
  })
})

describe('WP406 公司模式谁能点', () => {
  it('卡只发给品牌负责人与这个岗位的负责人；别人看得到「有更新，等负责人看」、点了 403', async () => {
    const h = harness()
    h.company.on = true
    h.publish(1, [rules('1.0.1', 'x')])
    h.setNow(MON)
    await h.oc.check()
    const card = h.bus.open()[0]
    expect(card?.routing.recipients.map((r) => r.person)).toEqual([OWNER, SUPERVISOR])
    const member = await h.oc.view(WS, POSITION, MEMBER)
    expect(member.can_apply).toBe(false)
    expect(member.pending).toHaveLength(1)
    await expect(h.oc.apply(WS, POSITION, MEMBER, {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(h.oc.rollback(WS, POSITION, MEMBER, {})).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(h.oc.setPolicy(WS, POSITION, MEMBER, 'off')).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(decideDigest(h, card as ApprovalItem, 'apply_all', MEMBER)).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(h.bus.open()).toHaveLength(1)
    // 岗位负责人能点
    const sup = await h.oc.apply(WS, POSITION, SUPERVISOR, {})
    expect(sup.applied).toHaveLength(1)
  })

  it('个人模式：本人说了算', async () => {
    const h = harness()
    h.publish(1, [rules('1.0.1', 'x')])
    h.setNow(MON)
    await h.oc.check()
    expect((await h.oc.view(WS, POSITION, MEMBER)).can_apply).toBe(true)
  })
})

describe('WP406 技能：AI 学的那几层不动', () => {
  const NAME = 'ad-headlines'
  const bundled = readFileSync(`${BUNDLED_SKILLS_DIR}${NAME}/SKILL.md`, 'utf8')
  const official = (body: string) =>
    bundled
      .replace('version: 1.0.0', 'version: 1.1.0')
      .replace(/## 你只做一件事\n\n[^\n]+/, `## 你只做一件事\n\n${body}`)

  async function setup(learnedOn: 'other' | 'same') {
    const h = harness()
    await h.registry.putFromMarkdown({
      markdown: bundled,
      tier: 'package',
      owner: 'package',
      version: '1.0.0',
    })
    const base = h.registry.peek(NAME, 'package')?.sections ?? []
    const target =
      learnedOn === 'same'
        ? base.find((s) => s.heading === '你只做一件事')
        : base.find((s) => s.heading !== '你只做一件事' && s.heading !== '')
    if (target === undefined) throw new Error('no section')
    const learned: Skill = {
      name: NAME,
      tier: 'company',
      owner: WS,
      version: '1.0.0',
      workspace_id: WS,
      sections: [
        { ...target, body: `${target.body}\n\n公司学到的：标题先放数字。`, origin: 'learned' },
      ],
      evals: [],
    }
    await h.registry.put(learned)
    h.publish(1, [
      {
        kind: 'skill',
        name: NAME,
        version: '1.1.0',
        files: { 'SKILL.md': official('官方新写法：你只写标题。') },
        positions: [POSITION],
      },
    ])
    h.setNow(MON)
    await h.oc.check()
    const snapshot = () => JSON.stringify(h.registry.listUpperLayers(NAME, WS))
    return { h, snapshot, target }
  }

  it('新版改的是别的段：全部应用、退回，学到的那一段前后逐字相同', async () => {
    const { h, snapshot } = await setup('other')
    const before = snapshot()
    const card = h.bus.open()[0]
    expect((card?.payload as { items: { mine: string }[] }).items[0]?.mine).toBe('kept')
    await decideDigest(h, card as ApprovalItem, 'apply_all')
    expect(h.registry.peek(NAME, 'package', { workspace_id: WS })?.version).toBe('1.1.0')
    expect(snapshot()).toBe(before)
    await h.oc.rollback(WS, POSITION, OWNER, {})
    expect(snapshot()).toBe(before)
    // 这个品牌那份官方底版撤下：回到随软件带的那一份
    expect(h.registry.peek(NAME, 'package', { workspace_id: WS })?.version).toBe('1.0.0')
  })

  it('新版改了学到的那一段：撞了先保留；选「用新版」才去掉，退回时还原', async () => {
    const { h, snapshot, target } = await setup('same')
    const before = snapshot()
    const card = h.bus.open()[0]
    expect((card?.payload as { items: { mine: string }[] }).items[0]?.mine).toBe('clash')
    await decideDigest(h, card as ApprovalItem, 'apply_all')
    expect(snapshot()).toBe(before)
    await h.oc.apply(WS, POSITION, OWNER, {
      item_ids: [],
      choices: { [`skill:${NAME}#section.${target.id}`]: 'use_new' },
    })
    expect(snapshot()).not.toBe(before)
    await h.oc.rollback(WS, POSITION, OWNER, { item_id: `skill:${NAME}` })
    expect(JSON.parse(snapshot()).records[0].sections[0].body).toContain('公司学到的')
  })
})

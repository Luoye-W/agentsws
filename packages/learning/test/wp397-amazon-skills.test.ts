/**
 * WP397：Amazon 运营岗位按需加载得到 Amazon 那批技能；客服岗、网站运营岗加载不到。
 *
 * 装配口径与运行时一致：一次运行的 `skills` = 被路由到的那条职责的 `skills:`；
 * 索引（`onDemandSkillIndex`）和 `read_skill`（`readSkillForRun`）读的是同一份清单。
 */
import type { SkillRef } from '@agentsws/contracts'
import { loadBundledPosition, loadBundledRole } from '@agentsws/roles'
import { createSkills, listBundledSkills, seedBundledSkills } from '@agentsws/skills'
import { describe, expect, it } from 'vitest'
import { onDemandSkillIndex, readSkillForRun } from '../src/index.js'

const AMAZON = listBundledSkills().filter((n) => n.startsWith('amazon-'))

async function fixture() {
  const skills = createSkills({
    clock: { now: () => '2026-10-18T00:00:00.000Z' },
    random: () => 0.5,
  })
  await seedBundledSkills(skills.registry)
  return skills
}

/** 这个岗位下每条职责的 `skills:`（职责 id → 清单）。 */
function skillsOfPosition(id: string): Map<string, SkillRef[]> {
  const out = new Map<string, SkillRef[]>()
  for (const r of loadBundledPosition(id).roles) {
    out.set(r.role, loadBundledRole(r.role).skills as SkillRef[])
  }
  return out
}

describe('WP397 岗位装配：Amazon 技能只在 Amazon 运营岗位上', () => {
  it('包里有 Amazon 技能（官方 12 本 + 改写 + 自写）', () => {
    expect(AMAZON.filter((n) => n.startsWith('amazon-sp-')).length).toBe(12)
    expect(AMAZON.length).toBeGreaterThanOrEqual(25)
  })

  it('亚马逊店铺运营登记了每一本，而且都是按需加载', () => {
    const store = loadBundledRole('amz.store').skills
    const names = store.map((s) => s.name)
    for (const n of AMAZON) expect(names, n).toContain(n)
    for (const s of store) expect(s.load, s.name).toBe('on_demand')
  })

  it('Amazon 运营岗位的运行请求：索引列得出、read_skill 读得到', async () => {
    const skills = await fixture()
    const runSkills = skillsOfPosition('amazon-ops').get('amz.store') ?? []
    const actor = { person_id: 'per_1', workspace_id: 'ws_1', role_id: 'amz.store' }
    const index = await onDemandSkillIndex({ skills: runSkills, actor, registry: skills.registry })
    for (const n of AMAZON)
      expect(
        index.map((e) => e.name),
        n,
      ).toContain(n)
    const read = await readSkillForRun({
      name: 'amazon-sp-stockout-prevention',
      skills: runSkills,
      actor,
      registry: skills.registry,
    })
    expect(read.status).toBe('ok')
    if (read.status === 'ok') expect(read.markdown).toContain('连上 Amazon 店铺后才能做')
    const inv = await readSkillForRun({
      name: 'amazon-inventory',
      skills: runSkills,
      actor,
      registry: skills.registry,
    })
    expect(inv.status === 'ok' && inv.markdown).toContain('连上 Amazon 店铺后才能算出具体数')
  })

  for (const position of ['customer-care', 'site', 'web-ops']) {
    it(`${position} 岗位：每条职责都加载不到 Amazon 技能，read_skill 报没登记`, async () => {
      const skills = await fixture()
      for (const [role_id, runSkills] of skillsOfPosition(position)) {
        for (const s of runSkills)
          expect(s.name.startsWith('amazon-'), `${role_id}:${s.name}`).toBe(false)
        const actor = { person_id: 'per_1', workspace_id: 'ws_1', role_id }
        const index = await onDemandSkillIndex({
          skills: runSkills,
          actor,
          registry: skills.registry,
        })
        expect(index.some((e) => e.name.startsWith('amazon-'))).toBe(false)
        const read = await readSkillForRun({
          name: 'amazon-sp-stockout-prevention',
          skills: runSkills,
          actor,
          registry: skills.registry,
        })
        expect(read.status).toBe('not_registered')
      }
    })
  }
})

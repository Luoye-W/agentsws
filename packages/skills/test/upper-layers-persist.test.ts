/**
 * WP320：技能库上层（公司 / 部门 / 岗位 / 职责 / 个人）能落盘、能装回来。
 *
 * 钉四件事：
 * 1. 上层的记录或 overlay 变了才叫 `onChange`；包基础层变了不叫（那一层每次启动重新种）；
 * 2. `exportUpperLayers` 只导上层，深拷贝（改快照不改库）；
 * 3. 换一个新库 `importUpperLayers` 之后，`resolve` 叠出来的东西与原来一样；
 * 4. 装回来的过程不叫 `onChange`（装回来不是"变了"，不然一启动就回写一遍）。
 */
import { describe, expect, it } from 'vitest'
import type { Actor } from '../src/index.js'
import { makeSkills } from './helpers.js'

const SKILL = `---
name: care
description: 客服说明书
---

## 退货

先查物流。
`

const ACTOR: Actor = {
  person_id: 'p_li',
  workspace_id: 'ws1',
  position_id: 'support',
  role_id: 'dtc.support',
}

async function seeded() {
  const { skills } = makeSkills()
  await skills.registry.putFromMarkdown({
    markdown: SKILL,
    tier: 'package',
    owner: 'package',
    version: '1.0.0',
  })
  return skills
}

describe('WP320 技能库上层落盘', () => {
  it('只有上层变了才叫 onChange', async () => {
    const skills = await seeded()
    let calls = 0
    const off = skills.registry.onChange(() => {
      calls += 1
    })
    await skills.registry.putFromMarkdown({
      markdown: SKILL,
      tier: 'package',
      owner: 'package',
      version: '1.0.1',
    })
    expect(calls).toBe(0)
    await skills.registry.put({
      name: 'care',
      tier: 'position',
      owner: 'support',
      version: '1.0.0',
      evals: [],
      sections: [{ id: 'sec_auto', heading: '语气', body: '回客户一律先道歉。', origin: 'authored' }],
      workspace_id: 'ws1',
      scope_id: 'support',
    })
    expect(calls).toBe(1)
    const section = skills.registry.listSections('care')[0]
    await skills.registry.setOverlay({
      skill: 'care',
      tier: 'role',
      owner: 'dtc.support',
      ops: [{ op: 'append', section_id: section?.id ?? '', body: '超过 30 天要说明原因。' }],
      base_version: '1.0.0',
      version: 0,
    })
    expect(calls).toBe(2)
    off()
    await skills.registry.drop('care', 'position', { workspace_id: 'ws1', scope_id: 'support' })
    expect(calls).toBe(2)
  })

  it('导出 → 新库装回 → 叠出来的一样；装回来不叫 onChange', async () => {
    const a = await seeded()
    await a.registry.put({
      name: 'care',
      tier: 'position',
      owner: 'support',
      version: '1.0.0',
      evals: [],
      sections: [{ id: 'sec_auto', heading: '语气', body: '回客户一律先道歉。', origin: 'authored' }],
      workspace_id: 'ws1',
      scope_id: 'support',
    })
    const section = a.registry.listSections('care')[0]
    await a.registry.setOverlay({
      skill: 'care',
      tier: 'role',
      owner: 'dtc.support',
      ops: [{ op: 'append', section_id: section?.id ?? '', body: '超过 30 天要说明原因。' }],
      base_version: '1.0.0',
      version: 0,
    })
    const snapshot = a.registry.exportUpperLayers()
    expect(snapshot.records.every((r) => r.tier !== 'package')).toBe(true)
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.overlays).toHaveLength(1)
    // 深拷贝：改快照不改库
    const first = snapshot.records[0]
    if (first?.sections[0] !== undefined) first.sections[0].body = '被改了'
    expect((await a.registry.resolve('care', ACTOR))?.markdown).not.toContain('被改了')

    const before = (await a.registry.resolve('care', ACTOR))?.markdown
    const b = await seeded()
    let calls = 0
    b.registry.onChange(() => {
      calls += 1
    })
    const fresh = a.registry.exportUpperLayers()
    expect(b.registry.importUpperLayers(fresh)).toEqual({ records: 1, overlays: 1 })
    expect(calls).toBe(0)
    const after = (await b.registry.resolve('care', ACTOR))?.markdown
    expect(after).toBe(before)
    expect(after).toContain('回客户一律先道歉。')
    expect(after).toContain('超过 30 天要说明原因。')
  })
})

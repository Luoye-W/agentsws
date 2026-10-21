/**
 * WP404（docs/107 §3 / §12 一期 A）：内容层叠到骨架上——白名单、往返、拒收。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  applyPositionContent,
  applyRoleContent,
  BUNDLED_POSITIONS_DIR,
  bundledRoleFile,
  checkContentFile,
  checkRoleContent,
  loadBundledPosition,
  loadBundledPositions,
  loadBundledPositionWithContent,
  loadBundledRole,
  loadBundledRoles,
  loadBundledRoleWithContent,
  loadPosition,
  loadRole,
  positionContentFileOf,
  positionContentOf,
  RoleSchemaError,
  roleContentFileOf,
  roleContentOf,
} from '../src/index.js'

/** 骨架那一半：把内容字段全换成「别的东西」，叠回去之后必须一个字段都看不出来。 */
const scrambled = <T extends Record<string, unknown>>(def: T, fields: readonly string[]): T => {
  const out: Record<string, unknown> = { ...def }
  for (const f of fields) if (f in out) out[f] = f === 'name' ? { zh: 'x', en: 'x' } : out[f]
  return out as T
}

describe('WP404 内容层往返：抽出来再套回去，和原 yml 加载结果逐字段相等', () => {
  it('全部 58 条内置职责（WP446 加了 dtc.seo、WP447 加了六条投放新平台）', () => {
    const roles = loadBundledRoles()
    expect(roles).toHaveLength(58)
    for (const role of roles) {
      const file = bundledRoleFile(role.id)
      const raw = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>
      const content = roleContentOf(raw)
      // 骨架上换掉名字（证明名字确实是内容层给的），再叠回去
      const skeleton = loadRole(file)
      const base = { ...skeleton, name: { zh: 'x', en: 'x' }, description: 'x' }
      expect(applyRoleContent(base, content)).toEqual(skeleton)
      expect(loadBundledRoleWithContent(role.id, content)).toEqual(loadBundledRole(role.id))
      // 内容文件也读得回来
      const roundtrip = JSON.parse(JSON.stringify(roleContentFileOf(role.id, content)))
      expect(checkContentFile(roundtrip, { kind: 'role', id: role.id })).toEqual(content)
    }
  })

  it('全部内置岗位模板', () => {
    for (const p of loadBundledPositions()) {
      const file = `${BUNDLED_POSITIONS_DIR}${p.id}.yml`
      const raw = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>
      const content = positionContentOf(raw)
      const skeleton = loadPosition(file)
      expect(applyPositionContent(scrambled(skeleton, ['name']), content)).toEqual(skeleton)
      expect(loadBundledPositionWithContent(p.id, content)).toEqual(loadBundledPosition(p.id))
      const roundtrip = JSON.parse(JSON.stringify(positionContentFileOf(p.id, content)))
      expect(checkContentFile(roundtrip, { kind: 'position', id: p.id })).toEqual(content)
    }
  })
})

describe('WP404 白名单外的字段整份拒收', () => {
  const role = () => loadRole(bundledRoleFile('kol.youtube'))

  it.each([
    ['scopes', []],
    ['automation', {}],
    ['thresholds', { x: 1 }],
    ['skills', []],
    ['browser_scope', ['evil.com']],
    ['actions', []],
    ['version', '9.9.9'],
    ['id', 'kol.other'],
  ])('%s 在内容层里 → 拒', (field, value) => {
    expect(() => applyRoleContent(role(), { description: 'ok', [field]: value })).toThrow(
      RoleSchemaError,
    )
  })

  it('grounding 只许换词表：写了 tool / prefetch 就拒；骨架里没有的 name 也拒', () => {
    const g = role().grounding?.[0]
    expect(g).toBeDefined()
    expect(() =>
      applyRoleContent(role(), { grounding: [{ name: g?.name, tool: 'send_email' }] }),
    ).toThrow(RoleSchemaError)
    expect(() =>
      applyRoleContent(role(), { grounding: [{ name: 'made_up', intent_terms: ['x'] }] }),
    ).toThrow(/no grounding named made_up/)
  })

  it('岗位：只认名字、角色定位、挂哪几条职责', () => {
    const p = loadBundledPosition('kol-marketing')
    expect(() => applyPositionContent(p, { icon: 'x' })).toThrow(RoleSchemaError)
    expect(() => applyPositionContent(p, { version: '2.0.0' })).toThrow(RoleSchemaError)
    const swapped = applyPositionContent(p, { roles: [{ role: 'kol.youtube', default: false }] })
    expect(swapped.roles).toEqual([{ role: 'kol.youtube', default: false }])
    expect(swapped.icon).toBe(p.icon)
  })

  it('形状不对也拒（快捷问题 id 格式、条数上限、id 重名、persona 缺段）', () => {
    const qp = (id: string) => ({ id, label: { zh: 'a', en: 'a' }, prompt: 'p', kind: 'ask' })
    expect(() => checkRoleContent({ quick_prompts: [qp('Bad-Id')] })).toThrow(RoleSchemaError)
    expect(() =>
      checkRoleContent({ quick_prompts: Array.from({ length: 9 }, (_, i) => qp(`q${i}`)) }),
    ).toThrow(RoleSchemaError)
    expect(() => applyRoleContent(role(), { quick_prompts: [qp('a'), qp('a')] })).toThrow(
      /duplicate id/,
    )
    expect(() => applyRoleContent(role(), { persona: { zh: '你是谁：只有一段。' } })).toThrow(
      /少了这几段/,
    )
  })
})

describe('WP404 叠法', () => {
  const base = () => loadRole(bundledRoleFile('kol.youtube'))

  it('没写的格子照基础版，不被补出来的默认值清空', () => {
    const out = applyRoleContent(base(), { description: '新的说明' })
    expect(out.description).toBe('新的说明')
    expect(out.quick_prompts).toEqual(base().quick_prompts)
    expect(out.task_examples).toEqual(base().task_examples)
    expect(out.grounding).toEqual(base().grounding)
    expect(out.persona).toEqual(base().persona)
  })

  it('grounding 按 name 对齐，只换写了的那张词表，tool / prefetch 不动', () => {
    const g = base().grounding?.[0]
    if (g === undefined) throw new Error('kol.youtube 应有 grounding')
    const out = applyRoleContent(base(), { grounding: [{ name: g.name, cue_terms: ['新词'] }] })
    expect(out.grounding?.[0]).toEqual({ ...g, cue_terms: ['新词'] })
    expect(out.grounding?.slice(1)).toEqual(base().grounding?.slice(1))
  })

  it('叠了新的中文 persona：生成的英文对不上哈希就不用（英文界面回落中文 + 未翻译）', () => {
    const zh = (base().persona as { zh: string }).zh.replace('红人营销岗位里', '红人岗位里')
    const out = loadBundledRoleWithContent('kol.youtube', { persona: { zh } })
    expect(out.persona).toEqual({ zh, en: '' })
    expect((loadBundledRole('kol.youtube').persona as { en: string }).en).not.toBe('')
  })

  it('内容文件：格式版本、种类、id 对不上都拒', () => {
    const file = roleContentFileOf('kol.youtube', { description: 'x' })
    expect(() =>
      checkContentFile({ ...file, schema: 'x/2' }, { kind: 'role', id: 'kol.youtube' }),
    ).toThrow(/unsupported content schema/)
    expect(() => checkContentFile(file, { kind: 'role', id: 'kol.tiktok' })).toThrow(
      /not role:kol.tiktok/,
    )
    expect(() =>
      checkContentFile({ ...file, extra: 1 }, { kind: 'role', id: 'kol.youtube' }),
    ).toThrow(/unknown field in content file/)
  })
})

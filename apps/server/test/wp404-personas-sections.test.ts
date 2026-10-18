/**
 * WP404（docs/107 §4）：公司改角色定位存成「按语言、按段」——服务端那一半。
 *
 * 交上来的仍是整段（右栏面板不变）；存的时候只记改了的段，叠出来的与改造前整段替换逐字节相同。
 */
import type { PersonaOverride } from '@agentsws/contracts'
import {
  loadBundledPosition,
  loadBundledRole,
  personaTextIn,
  type RoleStore,
} from '@agentsws/roles'
import { describe, expect, it } from 'vitest'
import { createMemoryPersonaBackend, createPersonas } from '../src/personas.js'

const ROLE_ID = 'kol.youtube'

function setup() {
  const backend = createMemoryPersonaBackend()
  const role = loadBundledRole(ROLE_ID)
  const personas = createPersonas({
    workspace_id: 'ws_1',
    clock: { now: () => '2026-10-19T00:00:00.000Z' },
    roles: { roles: new Map([[ROLE_ID, role]]) } as unknown as RoleStore,
    positions: () => [loadBundledPosition('kol-marketing')],
    backend,
    isOwner: () => true,
    appendEvent: () => undefined,
  })
  return { personas, backend, role }
}

describe('WP404 角色定位按段存', () => {
  it('改了一段：只存那一段；生效的就是交上来的整段，英文标未翻译', () => {
    const { personas, backend, role } = setup()
    const zh = personaTextIn(role.persona, 'zh').replace(/口气：[^\n]*/, '口气：像老朋友一样。')
    const view = personas.set({
      subject: { kind: 'role', id: ROLE_ID },
      text: { zh, en: '' },
      by: 'p1',
    })
    const row = backend.all()[0] as PersonaOverride
    expect(row.sections).toEqual({ zh: { tone: '像老朋友一样。' } })
    expect(row.text).toEqual({ zh, en: '' })
    expect(personaTextIn(view.effective, 'zh')).toBe(zh)
    expect(view.untranslated).toBe(true)
    expect(view.overridden_sections).toEqual(['tone'])
    const sections = personas.sections({ role_id: ROLE_ID })
    expect(sections.find((s) => s.id === 'role')?.text).toBe(zh)
  })

  it('岗位一样按段存', () => {
    const { personas, backend } = setup()
    const packaged = personaTextIn(loadBundledPosition('kol-marketing').persona, 'zh')
    const zh = packaged.replace(/怎么做：[^\n]*/, '怎么做：先看名单再动手。')
    personas.set({
      subject: { kind: 'position', id: 'kol-marketing' },
      text: { zh, en: '' },
      by: 'p1',
    })
    expect(backend.all()[0]?.sections).toEqual({ zh: { how: '先看名单再动手。' } })
    expect(personaTextIn(personas.effective({ kind: 'position', id: 'kol-marketing' }), 'zh')).toBe(
      zh,
    )
  })

  it('写成一整段的改写：照旧整段替换（不存 sections）', () => {
    const { personas, backend } = setup()
    const view = personas.set({
      subject: { kind: 'role', id: ROLE_ID },
      text: { zh: '你就是一个找红人的人，别的不管。', en: '' },
      by: 'p1',
    })
    expect(backend.all()[0]?.sections).toBeUndefined()
    expect(personaTextIn(view.effective, 'zh')).toBe('你就是一个找红人的人，别的不管。')
    expect(view.overridden_sections).toBeUndefined()
  })
})

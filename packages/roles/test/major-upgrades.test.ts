/**
 * WP462（急修，beta.5 真机）：职责升大版本之后，老分配怎么接上——门禁会跑的那一份。
 *
 * 1. **对着上一个发出去的版本核**（`fixtures/released-roles/versions.json`）：内置职责凡是大版本变了，
 *    `ROLE_MAJOR_UPGRADES` 里必须登记；登记成 `narrow` / `split`（启动时自动接上、不问人）的，
 *    再拿当时那份定义（`fixtures/released-roles/<id>@<大版本>.yml`）逐格核「真的没放宽」：
 *    动作、额度、自动化上限、数据范围、连接、浏览器白名单、网页工具，新的（含拆出去的那几条）
 *    都只能是旧的子集。以后谁再把一条职责升大版本却忘了登记 / 登记错了，这里红。
 * 2. 仓库层：`upgradeMajors` 自动接上（拆分补发、幂等、撤掉过的不再补）、没登记的不动、
 *    `reconfirm` 人点了才接、`staleMajor` 只回那一条。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createRoleStore,
  isStaleMajor,
  loadBundledRole,
  loadBundledRoles,
  majorOf,
  majorUpgradePath,
  parseRole,
  ROLE_MAJOR_UPGRADES,
  type RoleDefinitionFull,
  RoleError,
} from '../src/index.js'
import { fixedClock, member, owner } from './helpers.js'

const FIXTURES = new URL('./fixtures/released-roles/', import.meta.url)
const released = JSON.parse(readFileSync(new URL('versions.json', FIXTURES), 'utf8')) as {
  release: string
  roles: Record<string, string>
}
const releasedRole = (id: string, major: number): RoleDefinitionFull =>
  parseRole(readFileSync(new URL(`${id}@${major}.yml`, FIXTURES), 'utf8'), `${id}@${major}`)

const LEVELS = ['L1', 'L2', 'L3']
const SENSITIVITY = ['public', 'internal', 'confidential', 'restricted']
const RANGE = ['own', 'assigned', 'workspace']

/** `next` 比 `prev` 宽了的那几处（空 = 没放宽）。 */
function widenings(next: RoleDefinitionFull, prev: RoleDefinitionFull): string[] {
  const out: string[] = []
  for (const s of next.scopes) {
    const covered = prev.scopes.some(
      (p) =>
        p.domain === s.domain &&
        s.ops.every((op) => p.ops.includes(op)) &&
        RANGE.indexOf(p.range) >= RANGE.indexOf(s.range) &&
        SENSITIVITY.indexOf(p.max_sensitivity) >= SENSITIVITY.indexOf(s.max_sensitivity),
    )
    if (!covered) out.push(`scope ${s.domain}:${s.ops.join('/')}@${s.range}`)
  }
  for (const c of next.connectors) {
    const p = prev.connectors.find((x) => x.kind === c.kind)
    if (p === undefined || !c.grants.every((g) => p.grants.includes(g)))
      out.push(`connector ${c.kind}`)
  }
  for (const a of next.actions) {
    const p = prev.actions.find((x) => x.id === a.id)
    if (p === undefined) {
      out.push(`action ${a.id}`)
      continue
    }
    const was = p.mandate.window?.max_count
    const now = a.mandate.window?.max_count
    if (was !== undefined && (now === undefined || now > was)) out.push(`window ${a.id}`)
    for (const [cap, was] of Object.entries(p.mandate.caps ?? {})) {
      const now = a.mandate.caps?.[cap]
      if (typeof was === 'number' && (typeof now !== 'number' || now > was))
        out.push(`cap ${a.id}.${cap}`)
      if (Array.isArray(was) && (!Array.isArray(now) || now.some((x) => !was.includes(x))))
        out.push(`cap ${a.id}.${cap}`)
    }
    if (p.review_cannot_be_disabled === true && a.review_cannot_be_disabled !== true)
      out.push(`review ${a.id}`)
  }
  for (const [id, spec] of Object.entries(next.automation)) {
    const p = prev.automation[id]
    if (p === undefined) continue
    if (LEVELS.indexOf(spec.ceiling) > LEVELS.indexOf(p.ceiling)) out.push(`ceiling ${id}`)
  }
  for (const host of next.browser_scope ?? [])
    if (!(prev.browser_scope ?? []).includes(host)) out.push(`browser ${host}`)
  for (const tool of next.web_tools ?? [])
    if (!(prev.web_tools ?? []).includes(tool)) out.push(`web ${tool}`)
  return out
}

describe('WP462 门禁：内置职责升大版本必须登记，自动接上的必须真的没放宽', () => {
  const current = loadBundledRoles()
  const changed = current.filter((r) => {
    const was = released.roles[r.id]
    return was !== undefined && majorOf(was) !== majorOf(r.version)
  })

  it(`对着 ${released.release}：这次升了大版本的职责都登记了`, () => {
    // 这一份就是报告里那张表；以后再升大版本，这里会多一行，同时必须登记
    expect(changed.map((r) => `${r.id} ${released.roles[r.id]} → ${r.version}`)).toEqual([])
    for (const role of changed) {
      const path = majorUpgradePath(
        role.id,
        majorOf(released.roles[role.id] ?? ''),
        majorOf(role.version),
      )
      expect(
        path,
        `${role.id} 升了大版本却没登记（packages/roles/src/major-upgrades.ts）`,
      ).toBeDefined()
    }
  })

  it('登记成 narrow / split 的：新定义（连同拆出去的那几条）都是旧定义的子集', () => {
    for (const role of changed) {
      const from = majorOf(released.roles[role.id] ?? '')
      const path = majorUpgradePath(role.id, from, majorOf(role.version)) ?? []
      if (path.some((s) => s.kind === 'widen')) continue
      const prev = releasedRole(role.id, from)
      expect(widenings(role, prev), `${role.id}`).toEqual([])
      for (const heir of path.flatMap((s) => s.heirs ?? []))
        expect(widenings(loadBundledRole(heir), prev), `${role.id} → ${heir}`).toEqual([])
    }
  })

  it('登记表自己说得通：每行升的是大版本、拆分有接手的、接手的是内置职责', () => {
    for (const row of ROLE_MAJOR_UPGRADES) {
      expect(row.to_major).toBeGreaterThan(row.from_major)
      if (row.kind === 'split') expect(row.heirs?.length ?? 0).toBeGreaterThan(0)
      for (const heir of row.heirs ?? []) expect(() => loadBundledRole(heir)).not.toThrow()
    }
  })

  it('核对器自己会抓：拿旧版本当新版本（多出 SEO 那几样）对着新内容核，报出放宽', () => {
    const prev = loadBundledRole('dtc.content')
    const wider = releasedRole('dtc.content', 2)
    expect(widenings(wider, prev)).toEqual(
      expect.arrayContaining([
        'scope order:read@assigned',
        'connector search_console',
        'action stage_page_seo_edit',
      ]),
    )
  })
})

describe('WP462 仓库层：upgradeMajors / reconfirm / staleMajor', () => {
  const old = () => releasedRole('dtc.content', 2)
  /** 用 beta.4 那份「内容与搜索」2.0.0 授一条分配（带 SEO 三个动作的采纳率），再换上新定义。 */
  const seeded = () => {
    const s = createRoleStore({ clock: fixedClock(), roles: [old(), member(), owner()] })
    const a = s.assignments.create({
      person_id: 'p_owner',
      workspace_id: 'ws_1',
      role_id: 'dtc.content',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
      mandate_overrides: {
        stage_page_seo_edit: { window: { max_count: 5, per: 'day' } },
        stage_publish_post: { window: { max_count: 10, per: 'day' } },
      },
    })
    s.recordDecision(a.id, 'stage_page_seo_edit', 'accepted')
    s.recordDecision(a.id, 'stage_publish_post', 'accepted')
    expect(a.role_version).toBe('2.0.0')
    s.roles.register(loadBundledRole('dtc.content'))
    s.roles.register(loadBundledRole('dtc.seo'))
    return { s, a }
  }

  it('升上来之前：那一条拦下来说人话，staleMajor 回确认卡要的几格', () => {
    const { s, a } = seeded()
    expect(() => s.effectiveConfig(a.id)).toThrow(RoleError)
    expect(() => s.effectiveConfig(a.id)).toThrow(
      '「内容与博客」这条职责升级了，点一下确认就能接着用',
    )
    expect(s.staleMajor?.(a.id)).toEqual({
      reason: 'role_major_upgraded',
      assignment_id: a.id,
      role_id: 'dtc.content',
      role_name: '内容与博客',
      from: '2.0.0',
      to: '3.1.0',
    })
  })

  it('拆分自动接上：内容就地到当前版（WP449 起 3.1.0），补发 SEO 与 GEO（范围、额度覆盖、采纳率按动作搬过去）', () => {
    const { s, a } = seeded()
    const out = s.assignments.upgradeMajors()
    expect(out.map((r) => [r.role_id, r.kind, r.from, r.to, r.via, r.reason])).toEqual([
      ['dtc.seo', 'heir_granted', 'dtc.content@2.0.0', '1.0.0', 'auto', 'wp446'],
      ['dtc.content', 'reconfirmed', '2.0.0', '3.1.0', 'auto', 'wp446'],
    ])
    const content = s.assignments.require(a.id)
    expect(content.role_version).toBe('3.1.0')
    expect(Object.keys(content.automation_state).sort()).toEqual([
      'stage_listing_edit',
      'stage_publish_post',
    ])
    expect(content.automation_state.stage_publish_post?.adoption.accepted).toBe(1)
    expect(content.mandate_overrides).toEqual({
      stage_publish_post: { window: { max_count: 10, per: 'day' } },
    })
    expect(s.effectiveConfig(a.id).role_version).toBe('3.1.0')

    const heirId = out[0]?.assignment_id as string
    expect(out[0]?.heir_of).toBe(a.id)
    const seo = s.assignments.require(heirId)
    expect(seo).toMatchObject({
      person_id: 'p_owner',
      workspace_id: 'ws_1',
      role_id: 'dtc.seo',
      role_version: '1.0.0',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    expect(Object.keys(seo.automation_state).sort()).toEqual([
      'stage_internal_link_edit',
      'stage_page_section_add',
      'stage_page_seo_edit',
    ])
    expect(seo.automation_state.stage_page_seo_edit?.adoption.accepted).toBe(1)
    expect(seo.mandate_overrides).toEqual({
      stage_page_seo_edit: { window: { max_count: 5, per: 'day' } },
    })
    expect(s.effectiveConfig(heirId).ready).toBe(false)
    expect(s.staleMajor?.(a.id)).toBeUndefined()

    // 幂等：再跑一遍什么也不发生
    expect(s.assignments.upgradeMajors()).toEqual([])
  })

  it('已经担着 SEO 与 GEO 的不补第二条；补发过又撤掉的不再补', () => {
    const { s, a } = seeded()
    const own = s.assignments.create({
      person_id: 'p_owner',
      workspace_id: 'ws_1',
      role_id: 'dtc.seo',
      granted_by: 'p_owner',
    })
    const out = s.assignments.upgradeMajors()
    expect(out.map((r) => r.kind)).toEqual(['reconfirmed'])
    expect(s.assignments.listByPerson('p_owner', { role_id: 'dtc.seo' }).map((x) => x.id)).toEqual([
      own.id,
    ])
    expect(s.assignments.require(a.id).role_version).toBe('3.1.0')
  })

  it('没登记的大版本不自动：原样留着、出确认卡；人点了 reconfirm 才接上', () => {
    const { s, a } = seeded()
    // 换一张空登记表 = 「放宽 / 没登记」的那一种
    expect(s.assignments.upgradeMajors(undefined, [])).toEqual([])
    expect(s.assignments.require(a.id).role_version).toBe('2.0.0')
    expect(s.staleMajor?.(a.id)?.to).toBe('3.1.0')
    // widen 登记了也不自动
    expect(
      s.assignments.upgradeMajors(undefined, [
        { role_id: 'dtc.content', from_major: 2, to_major: 3, kind: 'widen', reason: 'x' },
      ]),
    ).toEqual([])
    const rec = s.assignments.reconfirm(a.id)
    expect(rec).toMatchObject({ kind: 'reconfirmed', from: '2.0.0', to: '3.1.0', via: 'person' })
    expect(s.effectiveConfig(a.id).role_version).toBe('3.1.0')
    // 人点的不补发拆出去的那条（补发只跟着登记过的拆分走）
    expect(s.assignments.listByPerson('p_owner', { role_id: 'dtc.seo' })).toEqual([])
    // 对上了再点：什么也不记
    expect(s.assignments.reconfirm(a.id)).toBeUndefined()
  })

  it('撤掉的分配不升、不给确认', () => {
    const { s, a } = seeded()
    s.assignments.revoke(a.id)
    expect(s.assignments.upgradeMajors()).toEqual([])
    expect(() => s.assignments.reconfirm(a.id)).toThrow(RoleError)
    expect(s.staleMajor?.(a.id)).toBeUndefined()
  })

  it('isStaleMajor / majorUpgradePath 的边', () => {
    expect(isStaleMajor({ role_version: '2.9.1' }, { version: '2.0.0' })).toBe(false)
    expect(isStaleMajor({ role_version: 'x' }, { version: '2.0.0' })).toBe(true)
    expect(majorUpgradePath('dtc.content', 2, 3)?.length).toBe(1)
    expect(majorUpgradePath('dtc.content', 1, 3)).toBeUndefined()
    expect(majorUpgradePath('dtc.content', 3, 2)).toBeUndefined()
    expect(majorUpgradePath('dtc.store', 1, 2)).toBeUndefined()
  })
})

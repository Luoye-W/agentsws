/**
 * WP179（Luoye 09-29「官方功能优先」）：职责模板的 `web_tools`（官方 `web_search` / `web_fetch`）。
 *
 * 钉四件事：
 * - 字段可选，不写 = 没有网页工具（老 yml 一个字不改）；拼错名字在加载时就拒；
 * - 派工单点名的那十四条职责挂了（WP220 又加了公关四条、社媒内容渠道八条）、客服类一条都没挂；
 * - 每条运行的上限从 `thresholds.web_*_per_run` 读，不写 / 写歪退回缺省 5 / 10；
 * - `effectiveConfig` 把它带出来（没挂的职责没有 `web` 这一格）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_WEB_LIMITS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_ROLES_DIR,
  createRoleStore,
  loadBundledRole,
  parseRole,
  RoleSchemaError,
  webOf,
} from '../src/index.js'
import { fixedClock } from './helpers.js'

const SUPPORT_YML = `${BUNDLED_ROLES_DIR}dtc/support.yml`

function bundledRoleIds(): string[] {
  const out: string[] = []
  for (const domain of readdirSync(BUNDLED_ROLES_DIR)) {
    const dir = join(BUNDLED_ROLES_DIR, domain)
    if (!statSync(dir).isDirectory()) continue
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.yml')) out.push(`${domain}.${file.slice(0, -4)}`)
    }
  }
  return out.sort()
}

/** 派工单点名：要查资料的职责。 */
const WITH_WEB = [
  'ads.google',
  'ads.meta',
  'ads.tiktok',
  'ads.x',
  'b2b.exhibition',
  'b2b.outbound',
  'b2b.sales',
  'dtc.content',
  'dtc.store',
  'kol.facebook',
  'kol.instagram',
  'kol.tiktok',
  'kol.x',
  'kol.youtube',
  // WP220：两份研究技能要上网查（公关四条、社媒内容渠道八条）
  'pr.forums',
  'pr.monitoring',
  'pr.press',
  'pr.reddit',
  'social.facebook',
  'social.instagram',
  'social.linkedin',
  'social.reddit',
  'social.threads',
  'social.tiktok',
  'social.x',
  'social.youtube',
]

/** 客服类：不让客服回复夹网页内容。 */
const SUPPORT_ROLES = ['amz.support', 'dtc.community-support', 'dtc.live-chat', 'dtc.support']

describe('WP179 web_tools 的 schema', () => {
  it('不写 = 没有网页工具（老 yml 不改）', () => {
    const role = parseRole(readFileSync(SUPPORT_YML, 'utf8'), 'dtc.support.yml')
    expect(role.web_tools ?? []).toEqual([])
    expect(webOf(role)).toEqual({})
  })

  it('只认官方那两个名字，拼错当场拒（不让它静默变成"没挂"）', () => {
    const base = readFileSync(SUPPORT_YML, 'utf8')
    expect(() => parseRole(`${base}\nweb_tools: [web_serch]\n`, 'x.yml')).toThrow(RoleSchemaError)
    const ok = parseRole(`${base}\nweb_tools: [web_fetch]\n`, 'x.yml')
    expect(ok.web_tools).toEqual(['web_fetch'])
  })
})

describe('WP179 哪些职责挂了网页工具', () => {
  it('名单上的职责都挂了两样', () => {
    for (const id of WITH_WEB) {
      expect(loadBundledRole(id).web_tools, id).toEqual(['web_search', 'web_fetch'])
    }
  })

  it('名单以外一条都没挂——客服类尤其不挂', () => {
    const others = bundledRoleIds().filter((id) => !WITH_WEB.includes(id))
    for (const id of [...others, ...SUPPORT_ROLES]) {
      expect(loadBundledRole(id).web_tools ?? [], id).toEqual([])
    }
  })
})

describe('WP179 每条运行的次数上限', () => {
  it('不写阈值 = 缺省 5 / 10；工具名排好序', () => {
    expect(webOf({ web_tools: ['web_search', 'web_fetch'] })).toEqual({
      web: { tools: ['web_fetch', 'web_search'], ...DEFAULT_WEB_LIMITS },
    })
  })

  it('职责阈值可调；写成 0 / 负数 / 小数不算数', () => {
    expect(
      webOf({
        web_tools: ['web_search'],
        thresholds: { web_search_per_run: 2, web_fetch_per_run: 20 },
      }).web,
    ).toEqual({ tools: ['web_search'], max_searches: 2, max_fetches: 20 })
    expect(
      webOf({
        web_tools: ['web_search'],
        thresholds: { web_search_per_run: 0, web_fetch_per_run: 1.5 },
      }).web,
    ).toEqual({ tools: ['web_search'], ...DEFAULT_WEB_LIMITS })
  })
})

describe('WP179 effectiveConfig 带出网页工具', () => {
  it('挂了的职责有 `web` 这一格；没挂的（客服）没有', () => {
    const s = createRoleStore({
      clock: fixedClock(),
      roles: [loadBundledRole('dtc.content'), loadBundledRole('dtc.support')],
    })
    const mk = (role_id: string) =>
      s.assignments.create({
        person_id: `p_${role_id}`,
        workspace_id: 'ws_1',
        role_id,
        ranges: [{ kind: 'store', id: 'shop_a' }],
        granted_by: 'p_owner',
      })
    const content = s.effectiveConfig(mk('dtc.content').id, { connected: [] })
    expect(content.web).toEqual({ tools: ['web_fetch', 'web_search'], ...DEFAULT_WEB_LIMITS })
    const support = s.effectiveConfig(mk('dtc.support').id, { connected: [] })
    expect('web' in support).toBe(false)
  })
})

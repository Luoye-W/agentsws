/**
 * WP360（决策 947，Luoye 10-16）：哪些职责 / 岗位「需要浏览器插件」只由职责定义里的 `browser_extension` 推出来。
 *
 * 钉四件事：
 * - 现在命中的就是这十四条职责（Reddit 两条、红人三条有插件面板的平台、广告两家有插件动作的后台、
 *   WP419 起社媒内容账号七条：到点打开发帖页、人点发布）；
 *   加一条要在这里加一行，并说清它拿插件做什么；
 * - 以 Reddit 为本职（`*.reddit`）的职责一定声明了 `reddit`（读 / 填回复都走插件）——忘了写会少一张引导卡；
 * - 岗位 = 默认勾的那几条职责的并集：红人营销、投放、公共关系、社媒运营（内容账号）命中；
 * - 拼错用途在加载时就拒，不让它静默变成「不需要插件」。
 */

import { readFileSync } from 'node:fs'
import { type BrowserExtensionUse, extensionFollowOf, extensionNeedOf } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_ROLES_DIR,
  loadBundledPositions,
  loadBundledRoles,
  parseRole,
  RoleSchemaError,
} from '../src/index.js'

const HITS: Record<string, BrowserExtensionUse[]> = {
  'ads.google': ['google_ads'],
  'ads.meta': ['meta_ads'],
  'kol.instagram': ['kol'],
  'kol.tiktok': ['kol'],
  'kol.youtube': ['kol'],
  'pr.reddit': ['reddit'],
  'social.reddit': ['reddit'],
  // WP419（决策 1231）：社媒内容账号发帖走你自己的登录态 + 插件（到点打开发帖页、人点发布）
  'social.facebook': ['social'],
  'social.instagram': ['social'],
  'social.linkedin': ['social'],
  'social.threads': ['social'],
  'social.tiktok': ['social'],
  'social.x': ['social'],
  'social.youtube': ['social'],
}

describe('WP360 需要插件的职责', () => {
  const roles = loadBundledRoles()

  it('命中的就是这十四条，用途写对', () => {
    const got = Object.fromEntries(
      roles
        .filter((r) => r.browser_extension !== undefined)
        .map((r) => [r.id, r.browser_extension?.uses]),
    )
    expect(got).toEqual(HITS)
  })

  // 以 Reddit 为本职 = 职责 id 就是 `*.reddit`。客服的社群管理、公关的品牌监控也挂着 Reddit 连接器，
  // 但 Reddit 只是它们十几个渠道里的一个、不靠插件读写——不算（不然整个客服岗位一上来就被要求装插件）。
  it('以 Reddit 为本职的职责都声明了 reddit', () => {
    const own = roles.filter((r) => r.id.endsWith('.reddit'))
    expect(own.map((r) => r.id).sort()).toEqual(['pr.reddit', 'social.reddit'])
    for (const r of own) {
      expect(r.connectors.some((c) => c.kind === 'reddit')).toBe(true)
      expect(r.browser_extension?.uses ?? [], r.id).toContain('reddit')
    }
  })

  it('岗位 = 默认勾的职责并集', () => {
    const byId = new Map(roles.map((r) => [r.id, r]))
    const need = (ids: string[]) =>
      extensionNeedOf(
        ids.flatMap((id) => {
          const r = byId.get(id)
          return r === undefined ? [] : [r]
        }),
      )
    const hits: Record<string, BrowserExtensionUse[] | undefined> = {}
    for (const p of loadBundledPositions()) {
      const n = need(p.roles.filter((x) => x.default).map((x) => x.role))
      if (n !== undefined) hits[p.id] = n.uses
    }
    expect(hits).toEqual({
      ads: ['google_ads', 'meta_ads'],
      'kol-marketing': ['kol'],
      pr: ['reddit'],
      // WP419：社媒运营默认勾的内容账号要插件发帖
      'social-media': ['social'],
    })
    // 自建「Reddit 运营」（自家版 + 别人的版）：一张卡、一个用途
    expect(need(['social.reddit', 'pr.reddit', 'social.discord'])).toEqual({
      uses: ['reddit'],
      role_ids: ['social.reddit', 'pr.reddit'],
    })
    expect(need(['social.discord', 'dtc.support'])).toBeUndefined()
  })

  it('配对之后的步与方案卡：去重、固定顺序', () => {
    expect(extensionFollowOf(['meta_ads', 'reddit', 'google_ads', 'kol'])).toEqual({
      steps: ['reddit', 'google_ads', 'meta_ads'],
      plans: ['reddit.watch', 'ads.accounts'],
    })
    expect(extensionFollowOf(['kol'])).toEqual({ steps: [], plans: [] })
  })

  it('拼错用途在加载时就拒', () => {
    const file = `${BUNDLED_ROLES_DIR}social/reddit.yml`
    const text = readFileSync(file, 'utf8').replace(
      'browser_extension: { uses: [reddit] }',
      'browser_extension: { uses: [redit] }',
    )
    expect(() => parseRole(text, file)).toThrow(RoleSchemaError)
    const empty = readFileSync(file, 'utf8').replace(
      'browser_extension: { uses: [reddit] }',
      'browser_extension: { uses: [] }',
    )
    expect(() => parseRole(empty, file)).toThrow(RoleSchemaError)
  })
})

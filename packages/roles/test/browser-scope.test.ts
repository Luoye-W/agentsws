/**
 * WP82（55 §3「域名白名单」那一行）：职责模板的 `browser_scope`。
 *
 * 四件事各钉一条：
 * - 字段是**可选**的，缺省是空数组——老 yml 一个字不改；**空 = 这条职责开不了浏览器**；
 * - 写歪了（带协议 / 路径 / 端口、通配放中间）在**加载时**就拒，不是等运行时静默失效；
 * - 该填的都填了（红人五条各自的平台、Amazon 只开卖家后台）、不该填的一条没填；
 * - 通配的判定（`hostAllowed`）与运行时是同一份，这里连着 yml 一起测一遍。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hostAllowed } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { BUNDLED_ROLES_DIR, loadBundledRole, parseRole, RoleSchemaError } from '../src/index.js'

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

/** 在 dtc.support 的 yml 上挂一段 `browser_scope`，用来测 schema。 */
function withScope(lines: string[]): string {
  const base = readFileSync(SUPPORT_YML, 'utf8')
  return `${base}\nbrowser_scope:\n${lines.map((l) => `  - ${l}\n`).join('')}`
}

describe('browser_scope 的 schema（05 §1，WP82）', () => {
  it('不写 = 空数组：老 yml 一个字不改，而空数组意味着这条职责开不了浏览器', () => {
    const role = parseRole(readFileSync(SUPPORT_YML, 'utf8'), 'dtc.support.yml')
    expect(role.browser_scope).toEqual([])
  })

  it('域名与通配都收得下', () => {
    const role = parseRole(withScope(['youtube.com', "'*.youtube.com'", 'youtu.be']), 'x.yml')
    expect(role.browser_scope).toEqual(['youtube.com', '*.youtube.com', 'youtu.be'])
  })

  for (const [what, line] of [
    ['带协议', "'https://youtube.com'"],
    ['带路径', "'youtube.com/@someone'"],
    ['带端口', "'youtube.com:443'"],
    ['通配放中间', "'youtube.*.com'"],
    ['不是域名', "'youtube'"],
    ['空串', "''"],
  ] as const) {
    it(`写歪了当场拒：${what}`, () => {
      // 为什么非拒不可：这些写法永远匹配不上 hostname，加载时放过去 = 白名单看着
      // 填了、实际上这条职责一个站都打不开（05 §5 那个拼错的键同一个毛病）
      expect(() => parseRole(withScope([line]), 'x.yml')).toThrow(RoleSchemaError)
    })
  }
})

describe('内置职责填了什么（55 §3）', () => {
  const expected: Record<string, string[]> = {
    'kol.youtube': ['youtube.com', '*.youtube.com', 'youtu.be'],
    'kol.facebook': ['facebook.com', '*.facebook.com', 'fb.com', '*.fb.com'],
    'kol.instagram': ['instagram.com', '*.instagram.com'],
    'kol.tiktok': ['tiktok.com', '*.tiktok.com'],
    'kol.x': ['x.com', '*.x.com', 'twitter.com', '*.twitter.com'],
    // WP73（56 §6）：Facebook 群组走浏览器，只开自己的群所在的那个域
    'social.facebook-group': ['*.facebook.com', 'facebook.com'],
    // WP78（60 §1）：论坛营销走浏览器（Quora / 知乎没有公开写接口）。
    // 这一份与 `@agentsws/pr-core` 的 `FORUM_HOSTS` 是同一批域名，
    // 对不上的时候 `pr-core` 的 `channels.test.ts` 会喊。
    'pr.forums': [
      '*.quora.com',
      'quora.com',
      '*.zhihu.com',
      'zhihu.com',
      '*.stackexchange.com',
      '*.discourse.org',
      '*.xda-developers.com',
      '*.reddit.com',
    ],
    'amz.support': [
      'sellercentral.amazon.com',
      'sellercentral-europe.amazon.com',
      'sellercentral-japan.amazon.com',
    ],
  }

  it('红人五条各自的平台 + Amazon 只开卖家后台，逐条对上', () => {
    for (const [id, hosts] of Object.entries(expected)) {
      expect(loadBundledRole(id).browser_scope, id).toEqual(hosts)
    }
  })

  it('其余职责一条都没填 = 它们开不了浏览器（白名单是"允许"表）', () => {
    for (const id of bundledRoleIds()) {
      if (id in expected) continue
      expect(loadBundledRole(id).browser_scope ?? [], id).toEqual([])
    }
  })

  it('Amazon 那条**开不了前台**：卖家后台是白名单，amazon.com 不是', () => {
    const hosts = expected['amz.support'] ?? []
    expect(hostAllowed('sellercentral.amazon.com', hosts)).toBe(true)
    expect(hostAllowed('www.amazon.com', hosts)).toBe(false)
    expect(hostAllowed('amazon.com', hosts)).toBe(false)
    // 前缀相同但不是同一个域的那种混淆域名也进不来
    expect(hostAllowed('sellercentral.amazon.com.evil.net', hosts)).toBe(false)
  })

  it('红人那五条的通配覆盖 www / m 子域，也覆盖裸域本身', () => {
    const yt = expected['kol.youtube'] ?? []
    for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']) {
      expect(hostAllowed(host, yt), host).toBe(true)
    }
    expect(hostAllowed('notyoutube.com', yt)).toBe(false)
    expect(hostAllowed('youtube.com.evil.net', yt)).toBe(false)
  })
})

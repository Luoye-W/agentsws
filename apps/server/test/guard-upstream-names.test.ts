/**
 * WP126（派工单定论 6 / Luoye 09-19）：**不泄露上游名**的守卫测试。
 *
 * 官方数据接口那一侧对外永远只叫「Agents 工坊官方数据接口」。界面、面向用户
 * 的文档、开放 API 的描述文本里，出现任何第三方数据平台的名字即失败——
 * 不告诉用户我们用的是哪家，也不替用户列市面上的同类服务。
 *
 * 名单放在测试里（不是配置文件——配置文件本身就是一个"提醒"的面）。
 * 覆盖官方上游与常见同类平台；`youtube` / `instagram` 这类**渠道名**不算。
 *
 * **只扫面向用户的面**。下面的内部位置不算违规（那是给我们自己看的）：
 * - `packages/kol-public/src/sources/*` 的文件名与代码（适配器实现）；
 * - 成本表与价目（`packages/metering/src/*.json`，运营后台那一侧可见）；
 * - 部署与运维文档（`docs/64`、`docs/65`——写给我们自己人，不发给用户）；
 * - 内部设计文档（`docs/48`、`docs/49`、`docs/66` 等非用户面文档）；
 * - 测试文件与这条守卫自己。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../../..')

/** 第三方数据平台的名字（小写）。覆盖官方上游与常见同类平台。 */
const FORBIDDEN_NAMES: readonly string[] = [
  // 官方上游
  'apify',
  // 常见同类（常见抓取 / 数据服务平台；只列名字，不做任何介绍）
  'brightdata',
  'oxylabs',
  'smartproxy',
  'decodo',
  'scrapingbee',
  'scrapingdog',
  'zenrows',
  'scrapfly',
  'zyte',
  'firecrawl',
  'crawlee',
  'phantombuster',
]

/** 要扫的面（相对仓库根）。目录 = 递归全扫；文件 = 单文件。 */
const USER_FACING_TARGETS: readonly string[] = [
  'apps/workstation/src',
  'apps/extension/src',
  'apps/cloud/src/pages.ts',
  'docs/60-公共关系岗位-v1.md',
  'docs/61-云端测试环境部署-v1.md',
  'docs/62-内测安装与升级-v1.md',
  'docs/63-消息与邮箱全量接入-v1.md',
  'docs/66-红人营销全流程验证-v1.md',
  'docs/67-付费三块与红人营销增值服务-v1.md',
  'docs/68-浏览器插件-v1.md',
  'docs/69-岗位与职责的角色定位-v1.md',
  'docs/70-初始化设置：先接AI与网址自动分析-v1.md',
  'docs/71-品牌设计规范DESIGN.md-v1.md',
  'docs/72-客服岗对标KefuAgent-差距与融入方案-v1.md',
  'docs/75-数据接口路由与自带数据接口-v1.md',
  'docs/76-插件开放接口-v1.md',
  'packages/sdk/openapi.json',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'build' || name.startsWith('.'))
      continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** openapi.json 里的描述文本（`description` 键的值）——不是整个 JSON 都算"面向用户"。 */
function openapiDescriptions(raw: string): string {
  const hits: string[] = []
  for (const match of raw.matchAll(/"description"\s*:\s*"([^"]*)"/gu)) hits.push(match[1] ?? '')
  return hits.join('\n')
}

describe('WP126 守卫：面向用户的面不出现第三方数据平台名', () => {
  it('目录与文档逐文件扫', () => {
    const offenders: { file: string; name: string }[] = []
    for (const target of USER_FACING_TARGETS) {
      const full = join(ROOT, target)
      let files: string[]
      try {
        files = statSync(full).isDirectory() ? walk(full) : [full]
      } catch {
        // 目标不存在（文档还没建）不算失败——守卫钉的是"出现了名字"
        continue
      }
      for (const file of files) {
        if (file.endsWith('.test.ts')) continue
        const text = readFileSync(file, 'utf8')
        const scanTarget = file.endsWith('openapi.json') ? openapiDescriptions(text) : text
        for (const name of FORBIDDEN_NAMES) {
          if (scanTarget.toLowerCase().includes(name)) offenders.push({ file, name })
        }
      }
    }
    expect(
      offenders,
      `面向用户的面出现了第三方数据平台名（对外只叫「Agents 工坊官方数据接口」）：\n` +
        offenders.map((o) => `  ${o.file}: ${o.name}`).join('\n'),
    ).toEqual([])
  })
})

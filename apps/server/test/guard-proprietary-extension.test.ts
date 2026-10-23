/**
 * WP119b（`docs/68` / `docs/76`）：**许可证守卫。**
 *
 * 旧浏览器插件（`Browser Extension - Influencer Assistant`）部分代码源自付费
 * 模板，授权不允许公开分发；完整版插件整体住在**私有仓库**
 * `agentsws-extension`。开源仓库这边只放开放接口与参考实现。
 *
 * 这组测试只干一件事：**防止移植代码被手滑提交进开源仓库**。WP496（决策 1739 A）起有一个例外：
 * 采集器与指标算法（DOM 只读采集、快照类型、体检 / 真实性 / 估值等纯算法）按决策搬进了
 * `packages/creator-capture`，那个包自己的守卫（`packages/creator-capture/test/guard.test.ts`）管它只放这些；
 * 插件框架、模板、面板 / 设置页这些照旧一个字节都不许进来。扫描的是
 * `apps/` 与 `packages/`（构建产物 `dist`、`node_modules`、文档里的"提到"不算），
 * 命中旧插件 / 模板特有的文件名、目录名或源码标识就当场红。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../../..')

/** 旧插件 / Plasmo 模板特有的标识。新增嫌疑名单时先确认它是模板特有的，不是通用词。 */
const FORBIDDEN = [
  'plasmo',
  'CreatorCaptureCard',
  'ContactPanel',
  'ContentCaptureCard',
  'ValuationSection',
  'WorkspacePanel',
  'BioLinkCaptureStrip',
  'AuthenticityBlock',
  'SyncStatusPanel',
  'GroupedModelSelector',
  'LanguageSwitcher',
  'useProductDetails',
  'kolagents.com',
  'influencer-api',
  // WP130：列表页批量采集那一批（完整版插件私有仓里的文件 / 函数名）
  'SearchCaptureFab',
  // WP496（决策 1739 A）：`collectSocialListCreators` 不再在这里——采集器与指标算法（不含插件框架 / 模板 / 界面）
  // 已经按决策搬进开源仓 `packages/creator-capture`（文件头写着出处）。界面那一批照旧一个字节都不许进来。
]

/**
 * 点名放行：这几个文件提到嫌疑名单里的某一项是**正当的**，不是移植代码。只放行写明的那一项。
 * - 官网首页「四级台阶」把 KOLAgents 链到它的官网（WP227，Luoye 10-05 #4）——一条公开链接，不是插件调用。
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'apps/site/src/config.ts': ['kolagents.com'],
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'build' || name.startsWith('.git')) {
      continue
    }
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 源码文件才读内容；名字命中就地红。 */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|json|css|mjs|yaml|yml|html)$/

describe('开源仓库守卫：私有插件的代码一个字节都不许进来', () => {
  it('没有旧插件 / 模板特有的文件名', () => {
    const files = walk(join(ROOT, 'apps')).concat(walk(join(ROOT, 'packages')))
    const offenders = files.filter((f) =>
      FORBIDDEN.some((needle) => f.toLowerCase().includes(needle.toLowerCase())),
    )
    expect(offenders, `这些文件名撞了嫌疑名单：\n${offenders.join('\n')}`).toEqual([])
  })

  it('没有旧插件 / 模板特有的源码标识', () => {
    const files = walk(join(ROOT, 'apps')).concat(walk(join(ROOT, 'packages')))
    const offenders: string[] = []
    for (const f of files) {
      if (!SOURCE_EXT.test(f)) continue
      if (f.includes('guard-proprietary-extension.test.ts')) continue
      const body = readFileSync(f, 'utf8')
      const rel = f
        .slice(ROOT.length + 1)
        .split('\\')
        .join('/')
      const allowed = ALLOWED[rel] ?? []
      const hit = FORBIDDEN.find((needle) => !allowed.includes(needle) && body.includes(needle))
      if (hit !== undefined) offenders.push(`${f}（命中「${hit}」）`)
    }
    expect(offenders, `这些源码文件提到了私有插件的内部标识：\n${offenders.join('\n')}`).toEqual([])
  })
})

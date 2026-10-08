/**
 * WP267：替用户跑平台 CLI 时**关掉它自己的自动升级**——别在用户电脑上 `npm install -g`（我们的私有安装由一键安装管版本）。
 *
 * Shopify CLI 4.8.5（`npm pack` 到临时目录读发行包核过，没装）：每条命令跑完的收尾钩子里，有新版本、并且
 * 「`CI` 没设」且「`shopify-cli-kit` 配置里 `autoUpgradeEnabled` 不是 false」（默认 true）就跑
 * `npm install -g @shopify/cli@latest`。没有专门关它的环境变量。
 *
 * - 非交互的命令（主题、找店、`store execute`、探版本）本来就带 `CI=1`——不会升级。
 * - **登录 / 店铺授权不能带 `CI`**（CLI 一看到就拒绝交互）——所以起它们之前，先在本品牌那一份配置目录里跑一次
 *   `config autoupgrade off`（带 `CI`；命令名里有 `upgrade`，它自己的收尾钩子也不会去升级），成了在那个目录里
 *   记一个标记，之后不再跑。重新登录会把配置目录挪走重建——新目录没有标记，自然再关一次。
 * - **没有本品牌配置目录**（内存档）就不跑：那时用的是用户自己整台电脑那一份 CLI 配置，我们不替他改。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlatformCliSpec } from '@agentsws/contracts'
import { cliSessionEnv } from './platform-cli-session.js'
import type { RunCli } from './shopify-theme.js'

/** 关好了的标记（在本品牌那一份 CLI 配置目录里；我们自己的文件，不碰 CLI 的配置文件）。 */
export const AUTOUPGRADE_OFF_MARKER = '.agentsws-autoupgrade-off'

export type AutoUpgradeOffResult = 'off' | 'already' | 'skipped' | 'failed'

/**
 * 在这个配置目录里把 CLI 的自动升级关掉（只跑一次）。**永不抛**：关不成也不挡登录 / 授权——
 * 最坏是 CLI 自己升级一次，和以前一样。
 */
export async function ensureCliAutoUpgradeOff(input: {
  spec: Pick<PlatformCliSpec, 'autoupgrade_off'>
  /** 本品牌那一份 CLI 配置目录；没有 = 不跑（见文件头）。 */
  home: string | undefined
  run: RunCli
  /** 子进程环境（白名单 + 关遥测）；这里再补 `CI` 与本品牌配置目录。 */
  env: Record<string, string>
  timeoutMs?: number
}): Promise<AutoUpgradeOffResult> {
  const off = input.spec.autoupgrade_off
  if (off === undefined || input.home === undefined) return 'skipped'
  const marker = join(input.home, AUTOUPGRADE_OFF_MARKER)
  if (existsSync(marker)) return 'already'
  try {
    mkdirSync(input.home, { recursive: true })
    const out = await input.run(off.config_args, {
      cwd: input.home,
      env: { ...input.env, ...off.env, ...cliSessionEnv(input.home) },
      timeoutMs: input.timeoutMs ?? 60_000,
    })
    if (out.code !== 0) return 'failed'
    writeFileSync(marker, `${new Date().toISOString()}\n`)
    return 'off'
  } catch {
    return 'failed'
  }
}

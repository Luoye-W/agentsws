/**
 * 仓库根在哪：从当前目录往上找 `pnpm-workspace.yaml`。
 * 构建时 Astro 会把页面打包到别处，`import.meta.url` 不可靠；构建总在仓库里跑，往上找最稳。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function repoRoot(from: string = process.cwd()): string {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error(`没找到仓库根（从 ${from} 往上没有 pnpm-workspace.yaml）`)
    dir = up
  }
}

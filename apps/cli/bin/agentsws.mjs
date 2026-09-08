#!/usr/bin/env node
import { existsSync } from 'node:fs'
// 入口壳：把构建产物（dist/index.js）跑起来。放在 bin/ 而不是 dist/，
// 这样 pnpm 在安装时（dist 还不存在）也能建好符号链接。
import { pathToFileURL } from 'node:url'

const entry = new URL('../dist/index.js', import.meta.url)
if (!existsSync(entry)) {
  process.stderr.write('agentsws: 未找到 dist/index.js，请先运行 `pnpm build`（tsc -b）\n')
  process.exit(70)
}
const mod = await import(pathToFileURL(entry.pathname).href)
await mod.main(process.argv)

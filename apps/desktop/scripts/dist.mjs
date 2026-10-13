#!/usr/bin/env node
/**
 * WP218：打包入口（`pnpm --filter @agentsws/desktop dist` / `package`）。
 *
 * 只做一件事：按环境变量与版本号算出这一包的**更新源**，用 `-c.publish.*` 覆盖
 * `electron-builder.yml` 里默认那一份，然后照常跑 electron-builder。规则与运行时同一份
 * （`dist/update-feed.js`，所以要先 `tsc -b`）：
 *
 *   AGENTSWS_UPDATE_PROVIDER = generic（默认，自有下载站）| github
 *   AGENTSWS_UPDATE_BASE_URL = https://dl.agentsws.com（默认）
 *   AGENTSWS_UPDATE_CHANNEL  = stable | beta（不给就按版本号：带 -beta.N 的是 beta）
 *
 * 其余参数原样交给 electron-builder（`--win`、`--mac --arm64`、`--dir` …）。
 * **一律 `--publish never`**：electron-builder 自己从不上传，上传由 release.yml 做（R2 + GitHub 同一套产物）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 打包参数：更新源覆盖 + 调用方给的 + `--publish never`（调用方给了别的 --publish 也压掉）。 */
export function distArgs(feedArgs, passthrough) {
  const rest = []
  for (let i = 0; i < passthrough.length; i += 1) {
    const arg = passthrough[i]
    if (arg === '--publish' || arg === '-p') {
      i += 1
      continue
    }
    if (arg.startsWith('--publish=')) continue
    rest.push(arg)
  }
  return [...rest, ...feedArgs, '--publish', 'never']
}

async function main() {
  const { feedFromEnv, builderArgs } = await import(
    new URL('../dist/update-feed.js', import.meta.url).href
  )
  const version = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).version
  const feed = feedFromEnv(process.env, version)
  const args = distArgs(builderArgs(feed), process.argv.slice(2))
  process.stdout.write(
    `  • 更新源：${feed.provider === 'generic' ? feed.url : `github ${feed.owner}/${feed.repo}`}（渠道 ${feed.channel}，版本 ${version}）\n`,
  )
  const cli = join(
    dirname(createRequire(import.meta.url).resolve('electron-builder/package.json')),
    'cli.js',
  )
  const out = spawnSync(process.execPath, [cli, ...args], { cwd: desktop, stdio: 'inherit' })
  process.exit(out.status ?? 1)
}

// Windows 上 argv[1] 与模块路径可能只差盘符大小写，按不分大小写比
const self = fileURLToPath(import.meta.url).toLowerCase()
if (process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === self) {
  await main()
}

#!/usr/bin/env node
/**
 * WP247：重出本机 OpenConnector 的锁文件（升级走 docs/42——改 `OPEN_CONNECTOR_PIN` 时一起跑）。
 *
 * 在一个临时目录里按 `hostPackageJson()` 写 package.json，跑 `npm install --package-lock-only`
 * （只解依赖、不下载包），把锁文件抄到 `packages/connect-adapter/src/open-connector-lock.json`，
 * 并打印 registry 上那一版的 `dist.integrity` 与锁文件里的是否一致。要联网；只在开发机上跑。
 *
 * WP355：默认**在现有锁文件上增量解**（先把它抄进临时目录）——只加 `overrides` 时只动被顶的那个包，
 * 不顺带把几十个无关的传递依赖漂到新版本；换 OpenConnector 版本时加 `--fresh` 从头解。
 * `overrides` 不写进锁文件根（npm 的锁文件格式不记它），由 `hostPackageJson()` 每次装的时候写进 package.json。
 *
 * 用法：pnpm -F @agentsws/connect-adapter build && node scripts/open-connector-lock.mjs [--fresh]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { hostPackageJson, OPEN_CONNECTOR_PIN } = await import(
  join(root, 'packages/connect-adapter/dist/local-runtime.js')
)
const target = join(root, 'packages/connect-adapter/src/open-connector-lock.json')
const fresh = process.argv.includes('--fresh')
const dir = mkdtempSync(join(tmpdir(), 'oc-lock-'))
try {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(hostPackageJson(), null, 2)}\n`)
  if (!fresh && existsSync(target)) copyFileSync(target, join(dir, 'package-lock.json'))
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: dir, stdio: 'inherit' },
  )
  copyFileSync(join(dir, 'package-lock.json'), target)
  const lock = JSON.parse(readFileSync(target, 'utf8'))
  const entry = lock.packages[`node_modules/${OPEN_CONNECTOR_PIN.package}`]
  const count = Object.keys(lock.packages).filter((p) => p !== '').length
  console.log(`锁文件：${target}（${count} 个包）`)
  console.log(`pin ${OPEN_CONNECTOR_PIN.version} ${OPEN_CONNECTOR_PIN.integrity}`)
  console.log(`锁  ${entry?.version} ${entry?.integrity}`)
  if (entry?.integrity !== OPEN_CONNECTOR_PIN.integrity) {
    console.error(
      '✗ 不一致：把 OPEN_CONNECTOR_PIN.integrity 改成锁文件里那一条（与 registry 的 dist.integrity 核一遍）',
    )
    process.exitCode = 1
  }
  console.log(
    '之后：npx biome format --write packages/connect-adapter/src/open-connector-lock.json',
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}

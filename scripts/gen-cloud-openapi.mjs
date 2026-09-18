#!/usr/bin/env node
/**
 * 由云侧的路由声明生成 `apps/cloud/openapi.json`（做法照 `gen-sdk.mjs`）。
 *
 * 不起服务、不开库：`collectCloudRoutes` 只需要一个 store 的壳就能列出声明，
 * 这里用内存档建一个再立刻关掉——路由声明本身就是唯一真源。
 *
 * 产物签进仓库：CI 里跑一遍再 `git diff --exit-code`，于是"改了云侧路由但忘了
 * 重生成"会红在 CI 上。
 *
 * 用法：`node scripts/gen-cloud-openapi.mjs`（先 `pnpm exec tsc -b`）
 *      `node scripts/gen-cloud-openapi.mjs --check` 只报差异，不写
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'apps/cloud/openapi.json')
const check = process.argv.includes('--check')

const dist = join(ROOT, 'apps/cloud/dist/index.js')
if (!existsSync(dist)) {
  process.stderr.write('gen-cloud-openapi: 先跑 `pnpm exec tsc -b`（要读 apps/cloud/dist）\n')
  process.exit(70)
}

const { buildCloudOpenApi, collectCloudRoutes, createCloudStore, consoleMailSender } = await import(
  pathToFileURL(dist).href
)

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
const clock = { now: () => '1970-01-01T00:00:00.000Z' }
const store = createCloudStore({ dbPath: ':memory:', clock })
const routes = collectCloudRoutes({
  store,
  clock,
  mail: consoleMailSender(() => {}),
  baseUrl: 'https://cloud.agentsws.com',
  version,
})
const doc = buildCloudOpenApi(routes, version)
store.close()

const json = `${JSON.stringify(doc, null, 2)}\n`

/** 生成物也要过仓库的格式化，否则 `biome check .` 会红。 */
const format = (file) => {
  execFileSync(join(ROOT, 'node_modules/.bin/biome'), ['check', '--write', file], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  return readFileSync(file, 'utf8')
}

if (check) {
  // 比的是**格式化之后**的样子：committed 的那份是 biome 排过版的，
  // 直接拿 JSON.stringify 的结果比会永远不一致。
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-cloud-openapi-'))
  const tmp = join(dir, 'openapi.json')
  writeFileSync(tmp, json)
  const formatted = format(tmp)
  rmSync(dir, { recursive: true, force: true })
  const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (before !== formatted) {
    process.stderr.write('gen-cloud-openapi --check: openapi.json 与路由声明不一致\n')
    process.exitCode = 1
  }
} else {
  writeFileSync(OUT, json)
  format(OUT)
  process.stdout.write(
    `gen-cloud-openapi: ${String(Object.keys(doc.paths).length)} 条路径 → apps/cloud/openapi.json\n`,
  )
}

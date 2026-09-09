#!/usr/bin/env node
/**
 * 由 `/v1` 的路由声明生成 `packages/sdk`（28 §2「OpenAPI 由契约类型自动生成」、
 * §3「CLI = 同一 OpenAPI 生成的客户端」）。
 *
 * 三步：
 * 1. `buildOpenApi(collectRoutes())` → `packages/sdk/openapi.json`
 *    （不起服务、不装配任何模块：路由声明本身就是唯一真源）
 * 2. `openapi-typescript` → `packages/sdk/src/schema.ts`
 * 3. `biome check --write` 把两份产物按仓库风格格式化
 *
 * 产物是**签进仓库**的：CI 里跑一遍再 `git diff --exit-code`，
 * 于是「改了路由但忘了重生成 SDK」会红在 CI 上，而不是等第三方接的时候才发现。
 *
 * 用法：`node scripts/gen-sdk.mjs`（先 `tsc -b`，它读 `packages/api/dist`）
 *      `node scripts/gen-sdk.mjs --check` 只报差异，不写
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SDK = join(ROOT, 'packages/sdk')
const OPENAPI_JSON = join(SDK, 'openapi.json')
const SCHEMA_TS = join(SDK, 'src/schema.ts')

const check = process.argv.includes('--check')

const apiDist = join(ROOT, 'packages/api/dist/index.js')
if (!existsSync(apiDist)) {
  process.stderr.write('gen-sdk: 先跑 `pnpm exec tsc -b`（要读 packages/api/dist）\n')
  process.exit(70)
}

const { buildOpenApi, collectRoutes } = await import(pathToFileURL(apiDist).href)

/** 版本号跟着根 package.json 走（服务进程运行期会用自己的版本覆盖 info.version）。 */
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
const doc = buildOpenApi(collectRoutes(), version)

const before = existsSync(OPENAPI_JSON) ? readFileSync(OPENAPI_JSON, 'utf8') : ''
const json = `${JSON.stringify(doc, null, 2)}\n`
if (!check) writeFileSync(OPENAPI_JSON, json)

// openapi-typescript 只吃文件 / URL；`--check` 时也要有一份最新的才能比
if (check && before !== json) {
  process.stderr.write('gen-sdk --check: openapi.json 与路由声明不一致\n')
  process.exitCode = 1
}

// openapi-typescript 是 packages/sdk 自己的 devDependency（不进根 package.json）
const cli = join(SDK, 'node_modules/.bin/openapi-typescript')
const generated = execFileSync(cli, [OPENAPI_JSON], { encoding: 'utf8', cwd: ROOT })

const banner = `/**
 * **自动生成，别手改。** 来源：\`/v1\` 的路由声明（\`packages/api/src/routes/*\`）。
 * 重新生成：\`node scripts/gen-sdk.mjs\`（CI 里生成后 \`git diff --exit-code\`）。
 */
`
const schema = banner + generated
const schemaBefore = existsSync(SCHEMA_TS) ? readFileSync(SCHEMA_TS, 'utf8') : ''
if (!check) writeFileSync(SCHEMA_TS, schema)

if (!check) {
  // 生成物也要过仓库的格式化，否则 CI 的 `biome check .` 会红
  execFileSync(
    join(ROOT, 'node_modules/.bin/biome'),
    ['check', '--write', OPENAPI_JSON, SCHEMA_TS],
    {
      cwd: ROOT,
      stdio: 'ignore',
    },
  )
  const paths = Object.keys(doc.paths).length
  process.stdout.write(`gen-sdk: ${paths} 条路径 → packages/sdk/{openapi.json,src/schema.ts}\n`)
} else if (schemaBefore.trim() !== schema.trim()) {
  process.stderr.write('gen-sdk --check: src/schema.ts 与 openapi.json 不一致\n')
  process.exitCode = 1
}

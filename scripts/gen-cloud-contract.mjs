#!/usr/bin/env node
/**
 * WP164（docs/83 §2 第 1 条）：由契约类型生成**云端对外契约**
 * `packages/contracts/cloud-openapi.json`。
 *
 * 与 `gen-cloud-openapi.mjs` 的分工：
 * - 那一份从 `apps/cloud` 的路由声明出 `apps/cloud/openapi.json`，含运营后台
 *   （`/v1/admin/*`），是云端**内部**的；随云端代码搬进私有仓。
 * - 这一份只含客户端与其他产品会调的路径，真源是
 *   `packages/contracts/src/cloud-api.ts` 的 `CloudApi` 路由表（TS 类型），
 *   是开源仓与私有仓之间**唯一的约定**。
 *
 * 不读 dist、不用先 `tsc -b`：直接用 TypeScript 编译器读契约源码。
 *
 * 用法：`node scripts/gen-cloud-contract.mjs`          重出
 *      `node scripts/gen-cloud-contract.mjs --check`  只比，不写（CI 用）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCloudContract, CLOUD_CONTRACT_OUT } from './cloud-contract-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, CLOUD_CONTRACT_OUT)
const check = process.argv.includes('--check')

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
const doc = buildCloudContract(ROOT, version)
const json = `${JSON.stringify(doc, null, 2)}\n`

/** 生成物也要过仓库的格式化，否则 `biome check .` 会红。 */
const format = (file) => {
  execFileSync(join(ROOT, 'node_modules/.bin/biome'), ['check', '--write', file], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  return readFileSync(file, 'utf8')
}

const count = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0)

if (check) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-cloud-contract-'))
  const tmp = join(dir, 'cloud-openapi.json')
  writeFileSync(tmp, json)
  const formatted = format(tmp)
  rmSync(dir, { recursive: true, force: true })
  const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (before !== formatted) {
    process.stderr.write(
      `gen-cloud-contract --check: ${CLOUD_CONTRACT_OUT} 与契约类型不一致——跑 \`node scripts/gen-cloud-contract.mjs\` 重出\n`,
    )
    process.exitCode = 1
  } else {
    process.stdout.write(`gen-cloud-contract --check: 零漂移（${String(count)} 条路由）\n`)
  }
} else {
  writeFileSync(OUT, json)
  format(OUT)
  process.stdout.write(`gen-cloud-contract: ${String(count)} 条路由 → ${CLOUD_CONTRACT_OUT}\n`)
}

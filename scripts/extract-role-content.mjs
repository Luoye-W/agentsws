#!/usr/bin/env node
/**
 * WP404（docs/107 §7 / §12 一期 A）：从开源仓的职责 / 岗位 yml 里**抽出内容那一半**，一条一个文件。
 *
 * 这是 WP407 私有内容仓的起点（冻结那天的基础版），也给测试用。只抽契约白名单里的字段
 * （`ROLE_CONTENT_FIELDS` / `POSITION_CONTENT_FIELDS`），按 yml 原样：persona 只有手写的中文那份。
 *
 * 布局（与 docs/107 §7 内容仓草案一致）：
 *   <out>/roles/<职责 id>/content.json
 *   <out>/positions/<岗位 id>/content.json
 *
 * 写完自检一遍：每一份套回骨架（`applyRoleContent` / `applyPositionContent`）都得和原 yml 的加载结果
 * 逐字段相等，有一条不等就退出码 1、不留半截。
 *
 * 用法：
 *   node scripts/extract-role-content.mjs --out <目录>     抽到目录里（目录里已有的同名文件会被覆盖）
 *   node scripts/extract-role-content.mjs --check          只自检往返，不写盘
 * 先跑 `pnpm exec tsc -b`（要读 packages/roles/dist）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function rolesDist() {
  const p = join(ROOT, 'packages/roles/dist/index.js')
  if (!existsSync(p)) {
    process.stderr.write(
      'extract-role-content: 先跑 `pnpm exec tsc -b`（要读 packages/roles/dist）\n',
    )
    process.exit(70)
  }
  return import(pathToFileURL(p).href)
}

/** 抽出全部内容文件，并逐条自检往返。回 `{ files: [{ path, data }], problems: string[] }`。 */
export async function extractRoleContent() {
  const roles = await rolesDist()
  const { roles: roleFiles, positions } = roles.bundledContentFiles()
  const files = []
  const problems = []
  for (const f of roleFiles) {
    files.push({ path: `roles/${f.id}/content.json`, data: f })
    const again = roles.loadBundledRoleWithContent(f.id, f.content)
    if (!isDeepStrictEqual(again, roles.loadBundledRole(f.id)))
      problems.push(`role:${f.id} 套回去和原 yml 不一致`)
  }
  for (const f of positions) {
    files.push({ path: `positions/${f.id}/content.json`, data: f })
    const again = roles.loadBundledPositionWithContent(f.id, f.content)
    if (!isDeepStrictEqual(again, roles.loadBundledPosition(f.id)))
      problems.push(`position:${f.id} 套回去和原 yml 不一致`)
  }
  return { files, problems }
}

async function main() {
  const args = process.argv.slice(2)
  const outAt = args.indexOf('--out')
  const out = outAt < 0 ? undefined : args[outAt + 1]
  if (out === undefined && !args.includes('--check')) {
    process.stderr.write('用法：extract-role-content.mjs --out <目录> | --check\n')
    process.exit(64)
  }
  const { files, problems } = await extractRoleContent()
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`✗ ${p}\n`)
    process.exit(1)
  }
  if (out !== undefined) {
    for (const f of files) {
      const target = join(resolve(out), f.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, `${JSON.stringify(f.data, null, 2)}\n`, 'utf8')
    }
  }
  const nRoles = files.filter((f) => f.path.startsWith('roles/')).length
  process.stdout.write(
    `✓ ${nRoles} 条职责、${files.length - nRoles} 个岗位的内容${out === undefined ? '往返自检通过' : `已写到 ${out}`}\n`,
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()

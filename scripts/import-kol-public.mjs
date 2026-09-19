#!/usr/bin/env node
/**
 * 把导出来的 NDJSON 分块推到云上的公共红人库（WP116 §3 第二步）。
 *
 * ```
 * AGENTSWS_CLOUD_ADMIN_TOKEN=… node scripts/import-kol-public.mjs https://cloud.agentsws.com
 * ```
 *
 * 五条：
 *
 * 1. **钥匙只从环境变量读**（`AGENTSWS_CLOUD_ADMIN_TOKEN`），不接受命令行参数
 *    ——命令行参数会进 shell history 与 `ps`。
 * 2. **按文件名排序推**：`01-person` → `02-creator` → 其余。`creator` 没落之前
 *    `contact` 找不到归属的那张卡。
 * 3. **一趟 ≤ 500 行**（`MAX_KOL_IMPORT_BATCH`）。云那一侧超了会直接拒，
 *    所以分块在这一侧做。
 * 4. **可重跑**：幂等键是 `渠道 + handle`（内容是 `渠道 + 原生 id`），
 *    第二趟全是 `updated`。网断了就再跑一次，不用清任何东西。
 * 5. **屏幕上只有数**：推上去的行里有真实邮箱，所以失败时打的是
 *    "第几块、多少行、什么状态码"，**不打任何一行的内容**。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 钥匙只认这一个名字。 */
const TOKEN_ENV = 'AGENTSWS_CLOUD_ADMIN_TOKEN'

/** 一趟推多少行（与 `contracts` 的 `MAX_KOL_IMPORT_BATCH` 对齐）。 */
export const BATCH = 500

/** 搬家那条路由。 */
export const IMPORT_PATH = '/v1/admin/kol/import'

/** 把一份 NDJSON 文本切成 ≤ {@link BATCH} 行的几块（空行不算行）。 */
export function chunk(text, size = BATCH) {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const out = []
  for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size))
  return out
}

/** 目录里要推的那几个文件，**按名字排序**（名字里的序号就是顺序）。 */
export function filesIn(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort()
}

/** 把几趟的结果加起来（rejected 按理由合并）。 */
export function merge(results) {
  const total = { received: 0, inserted: 0, updated: 0, skipped: 0, rejected: [] }
  const reasons = new Map()
  for (const one of results) {
    total.received += one.received ?? 0
    total.inserted += one.inserted ?? 0
    total.updated += one.updated ?? 0
    total.skipped += one.skipped ?? 0
    for (const r of one.rejected ?? [])
      reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.count)
  }
  total.rejected = [...reasons].map(([reason, count]) => ({ reason, count }))
  return total
}

function usage(message) {
  console.error(message)
  console.error('')
  console.error(`用法：${TOKEN_ENV}=… node scripts/import-kol-public.mjs <云的地址> [--dir <目录>]`)
  console.error('      例：node scripts/import-kol-public.mjs https://cloud.agentsws.com')
  process.exit(1)
}

/** 一块的 POST。**失败原样回给调用方决定重试还是停**。 */
export async function postBatch(deps, lines) {
  const res = await deps.fetch(`${deps.baseUrl}${IMPORT_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.token}`,
      'content-type': 'application/x-ndjson',
    },
    body: `${lines.join('\n')}\n`,
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, body: text.slice(0, 300) }
  try {
    const parsed = JSON.parse(text)
    // 云那一侧的信封是 `{ data: … }`（`cloudOk`），也认裸的那一份
    return { ok: true, result: parsed.data ?? parsed }
  } catch {
    return { ok: false, status: res.status, body: '响应不是 JSON' }
  }
}

/** 推一个目录。回每个文件的结果（**不打内容**由调用方负责）。 */
export async function pushDir(deps, dir) {
  const out = []
  for (const name of filesIn(dir)) {
    const blocks = chunk(readFileSync(join(dir, name), 'utf8'))
    const results = []
    for (const [i, lines] of blocks.entries()) {
      const res = await postBatch(deps, lines)
      if (!res.ok) {
        out.push({ file: name, failed: { block: i + 1, of: blocks.length, ...res } })
        return out
      }
      results.push(res.result)
      deps.onBlock?.({ file: name, block: i + 1, of: blocks.length, result: res.result })
    }
    out.push({ file: name, blocks: blocks.length, result: merge(results) })
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const baseUrl = args.find((a) => !a.startsWith('--'))
  if (baseUrl === undefined) usage('要给一个云的地址。')
  const dirIdx = args.indexOf('--dir')
  const dir = resolve(
    ROOT,
    dirIdx >= 0 ? (args[dirIdx + 1] ?? '.data/kolagents-public') : '.data/kolagents-public',
  )
  const token = process.env[TOKEN_ENV]
  if (token === undefined || token.trim() === '') usage(`没有设 ${TOKEN_ENV}。`)

  console.log(`推到 ${baseUrl.replace(/\/+$/, '')}${IMPORT_PATH}，来源目录 ${dir}`)
  const out = await pushDir(
    {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      token: token.trim(),
      fetch: globalThis.fetch,
      onBlock: ({ file, block, of }) => {
        process.stdout.write(`\r  ${file}  第 ${block}/${of} 块…`)
      },
    },
    dir,
  )
  process.stdout.write('\r')
  let bad = false
  for (const one of out) {
    if (one.failed !== undefined) {
      bad = true
      console.error(
        `  ${one.file}  第 ${one.failed.block}/${one.failed.of} 块失败（HTTP ${String(one.failed.status)}）：${one.failed.body}`,
      )
      console.error('  已经推进去的那几块不用清——再跑一次这个命令就是补差（幂等）。')
      continue
    }
    const r = one.result
    console.log(
      `  ${one.file}  ${String(one.blocks)} 块 · 收 ${String(r.received)} · 新 ${String(r.inserted)} · 更 ${String(r.updated)} · 跳 ${String(r.skipped)}`,
    )
    for (const rej of r.rejected) console.log(`      拒 ${String(rej.count)} 行：${rej.reason}`)
  }
  if (bad) process.exitCode = 1
  else console.log('\n都推完了。后台「红人库」那一页能看到数了。')
}

// 被 import 时（测试）不跑
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}

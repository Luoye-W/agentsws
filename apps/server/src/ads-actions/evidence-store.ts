/**
 * WP313（决策 556）：前后截屏按文件落盘，**存 180 天**。
 *
 * 目录：`<品牌目录>/ads-actions/evidence/<年-月>/<id>.png`，索引一行一条（`index.jsonl`）。
 * 只删自己存的、过了 `kept_until` 的那几张（按索引逐张点名删，不扫目录、不批量清）。
 * 接进变更账本（每条变更挂上它的前后截图、同步规则同账本）在 WP316。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type ActionEvidenceRecord,
  type ActionEvidenceStore,
  EVIDENCE_RETENTION_MS,
  evidenceUrl,
} from '@agentsws/browser-action'

export function fileEvidenceStore(options: {
  dir: string
  nowMs(): number
  id?(): string
}): ActionEvidenceStore {
  const index = join(options.dir, 'index.jsonl')
  const fileOf = (r: ActionEvidenceRecord): string =>
    join(options.dir, r.taken_at.slice(0, 7).replace(/[^0-9-]/gu, '') || 'misc', `${r.id}.png`)

  const readIndex = (): ActionEvidenceRecord[] => {
    if (!existsSync(index)) return []
    const out: ActionEvidenceRecord[] = []
    for (const line of readFileSync(index, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as ActionEvidenceRecord)
      } catch {
        // 半行（写到一半断电）：跳过
      }
    }
    return out
  }

  return {
    async put(input) {
      const now = options.nowMs()
      const record: ActionEvidenceRecord = {
        id: `ev_${options.id?.() ?? randomUUID().replace(/-/gu, '').slice(0, 16)}`,
        workspace_id: input.workspace_id,
        job_id: input.job_id,
        ...(input.approval_id === undefined ? {} : { approval_id: input.approval_id }),
        tag: input.tag,
        mime: 'image/png',
        bytes: input.png.byteLength,
        url: evidenceUrl(input.url),
        taken_at: input.taken_at,
        kept_until: new Date(now + EVIDENCE_RETENTION_MS).toISOString(),
      }
      const file = fileOf(record)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, input.png)
      appendFileSync(index, `${JSON.stringify(record)}\n`)
      return record
    },
    async list(job_id) {
      return readIndex().filter((r) => r.job_id === job_id)
    },
    async read(id) {
      const r = readIndex().find((x) => x.id === id)
      if (r === undefined) return undefined
      const file = fileOf(r)
      return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined
    },
    async prune(nowMs) {
      const all = readIndex()
      const keep: ActionEvidenceRecord[] = []
      let dropped = 0
      for (const r of all) {
        if (Date.parse(r.kept_until) <= nowMs) {
          rmSync(fileOf(r), { force: true })
          dropped += 1
        } else keep.push(r)
      }
      if (dropped > 0) {
        mkdirSync(options.dir, { recursive: true })
        writeFileSync(index, keep.map((r) => `${JSON.stringify(r)}\n`).join(''))
      }
      return dropped
    },
  }
}

/** 测试与没有数据目录的进程用（重启就没了）。 */
export function memoryEvidenceStore(options: { nowMs(): number }): ActionEvidenceStore {
  const rows: { record: ActionEvidenceRecord; png: Uint8Array }[] = []
  let n = 0
  return {
    async put(input) {
      n += 1
      const record: ActionEvidenceRecord = {
        id: `ev_${n}`,
        workspace_id: input.workspace_id,
        job_id: input.job_id,
        ...(input.approval_id === undefined ? {} : { approval_id: input.approval_id }),
        tag: input.tag,
        mime: 'image/png',
        bytes: input.png.byteLength,
        url: evidenceUrl(input.url),
        taken_at: input.taken_at,
        kept_until: new Date(options.nowMs() + EVIDENCE_RETENTION_MS).toISOString(),
      }
      rows.push({ record, png: input.png })
      return record
    },
    async list(job_id) {
      return rows.filter((r) => r.record.job_id === job_id).map((r) => r.record)
    },
    async read(id) {
      return rows.find((r) => r.record.id === id)?.png
    },
    async prune(nowMs) {
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i]
        if (r !== undefined && Date.parse(r.record.kept_until) <= nowMs) rows.splice(i, 1)
      }
      return before - rows.length
    },
  }
}

/**
 * 前后截屏留档（决策 556）：只截广告后台那个标签页，**跟着变更账本存 180 天**。
 *
 * 本单只留存储接口（WP313 第 7 条）；接进变更账本在 WP316。本机服务那一侧有一个按文件落盘的
 * 实现（`apps/server/src/ads-actions/evidence-store.ts`），过期的按账本同一条规矩删。
 */

import type { EvidenceTag } from './types.js'

export const EVIDENCE_RETENTION_DAYS = 180
export const EVIDENCE_RETENTION_MS = EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** 一张截图最大多少（PNG；超了不收，插件那边照实报）。 */
export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024

export interface ActionEvidenceRecord {
  id: string
  workspace_id: string
  job_id: string
  approval_id?: string
  tag: EvidenceTag
  mime: 'image/png'
  bytes: number
  /** 截图时页面的网址（只记主机 + 路径，不记查询串里的东西）。 */
  url: string
  taken_at: string
  kept_until: string
}

export interface ActionEvidenceStore {
  put(
    input: Omit<ActionEvidenceRecord, 'id' | 'bytes' | 'kept_until' | 'mime'> & {
      png: Uint8Array
    },
  ): Promise<ActionEvidenceRecord>
  list(job_id: string): Promise<ActionEvidenceRecord[]>
  /** 读回原图（给变更账本 / 申诉用）。 */
  read(id: string): Promise<Uint8Array | undefined>
  /** 删掉过了 `kept_until` 的。回删了几张。 */
  prune(nowMs: number): Promise<number>
}

/** 记网址只留主机 + 路径。 */
export function evidenceUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return ''
  }
}

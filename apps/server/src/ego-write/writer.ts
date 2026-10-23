/**
 * WP483（决策 1658 / 1660）：服务端「在 ego 里发」的那一只手——Reddit 写、社媒发帖 / 回帖共用。
 *
 * - `available()`：这会儿 ego 能不能用（由注入的 `egoPath()` 说了算：本机档 + 浏览器选了 ego（或没选过、默认 ego）+ 探得到）。
 * - `run(cfg)`：补上 Space 名与 ego 路径，跑一次（写 / 读回）。
 * - `materializeMedia`：帖子挂的图 / 视频（`blob://…` 或外链）落成本机临时文件给 ego 的 `setInputFiles`，跑完删掉。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgoWriteResult } from '@agentsws/contracts'
import { type EgoSpawn, runEgoWrite } from './runner.js'
import type { EgoWriteScriptConfig } from './script.js'

export type EgoWriteCall = Omit<EgoWriteScriptConfig, 'space'> & { space?: string }

export interface EgoWriter {
  available(): boolean
  run(cfg: EgoWriteCall): Promise<EgoWriteResult>
}

export interface EgoWriterOptions {
  /** 能用就回 `ego-browser` 的路径；用不了回 `undefined`。 */
  egoPath(): string | undefined
  spawn?: EgoSpawn
  timeoutMs?: number
}

export function createEgoWriter(options: EgoWriterOptions): EgoWriter {
  return {
    available: () => options.egoPath() !== undefined,
    async run(cfg) {
      const egoPath = options.egoPath()
      if (egoPath === undefined)
        return { state: 'unavailable', platform: cfg.platform, why: 'ego 没装好或没选用' }
      return runEgoWrite({
        egoPath,
        cfg: { ...cfg, space: cfg.space ?? `工坊 · ${cfg.platform}` },
        ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
    },
  }
}

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
}

/** 一个素材最大多少（防一条坏链接把磁盘写满）。 */
export const EGO_MEDIA_MAX_BYTES = 512 * 1024 * 1024

export interface MaterializeOptions {
  /** 读一个 blob（`blob://key` 去掉前缀后的 key）。 */
  readBlob?(
    key: string,
  ): Promise<{ bytes: Uint8Array; content_type?: string; filename?: string } | undefined>
  fetch?: typeof fetch
  /** 临时目录放在哪（缺省系统临时目录）。 */
  root?: string
}

/**
 * 帖子素材 → 本机临时文件。认不出 / 取不到任何一个就整条回 `why`（宁可退插件，也不少挂一张图发出去）。
 */
export async function materializeMedia(
  refs: readonly string[],
  options: MaterializeOptions,
): Promise<{ files: string[]; cleanup(): void } | { why: string }> {
  if (refs.length === 0) return { files: [], cleanup: () => undefined }
  const root = options.root ?? tmpdir()
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'agentsws-ego-media-'))
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 删不掉下次系统清
    }
  }
  const files: string[] = []
  try {
    for (const [i, ref] of refs.entries()) {
      let bytes: Uint8Array | undefined
      let type: string | undefined
      if (/^https?:\/\//iu.test(ref)) {
        const f = options.fetch ?? fetch
        const res = await f(ref)
        if (!res.ok) throw new Error(`素材下载不下来（${res.status}）`)
        const buf = new Uint8Array(await res.arrayBuffer())
        bytes = buf
        type = res.headers.get('content-type')?.split(';')[0]?.trim()
      } else {
        const key = ref.startsWith('blob://') ? ref.slice('blob://'.length) : ref
        const got = await options.readBlob?.(key)
        if (got === undefined) throw new Error(`素材库里找不到这一个（${ref}）`)
        bytes = got.bytes
        type = got.content_type
      }
      if (bytes.byteLength > EGO_MEDIA_MAX_BYTES) throw new Error('素材太大')
      const ext =
        (type === undefined ? undefined : EXT[type.toLowerCase()]) ??
        /\.(png|jpe?g|webp|gif|mp4|mov|webm)(\?|$)/iu.exec(ref)?.[0]?.replace(/\?$/u, '') ??
        '.bin'
      const path = join(dir, `media-${i + 1}${ext}`)
      writeFileSync(path, bytes)
      files.push(path)
    }
  } catch (err) {
    cleanup()
    return { why: err instanceof Error ? err.message : String(err) }
  }
  return { files, cleanup }
}

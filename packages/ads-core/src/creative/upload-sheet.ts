/**
 * WP317（docs/101 §5.1④「出口」）：一轮新文案 → **WP314 的上传表**（给人下载）。
 *
 * 表本身由 WP314 的 `buildAdUploadBundle` 生成（两家官方模板列名、必填与字数校验、
 * 新建一律暂停并按生成出来的表复查、摘要、指纹）。这里只做两件事：
 *
 * 1. 把这一轮收下的文案拼成「新建广告」的 op（`CreateAdOp`）。
 *    - Google：一条旧广告 → 一条新的自适应搜索广告（收下的标题 / 描述全放进去）。
 *    - Meta：一条广告只有一个标题一段正文，收下的几对配成几条新广告（第 i 条标题配第 i 段正文）。
 *      Meta 还要主页编号与图片（`page_id` / `image_hash`）——表里没有就让人补，不编。
 * 2. 把生成结果投影成给人下载的 {@link AdUploadSheet}（二进制的 .xlsx 转 base64）。
 *
 * **只出新建，不改在跑的广告**：Google 不许就地改在跑的广告文案，正确做法是建新的、
 * 跑出数再停旧的；停旧的是另一张卡。
 */

import type { AdCreativePlatform, AdUploadSheet, AdUploadSheetFile } from '@agentsws/contracts'
import { type BuildAdUploadInput, buildAdUploadBundle } from '../sheets/build.js'
import type { AdUploadBundle, CreateAdOp } from '../sheets/types.js'

/** 上传表里的一条新广告（来自一轮新文案 + 导出表那一行）。 */
export interface AdUploadSheetAd {
  campaign: string
  ad_group: string
  campaign_id?: string
  ad_group_id?: string
  final_url?: string
  headlines: readonly string[]
  descriptions: readonly string[]
}

export interface CreativeSheetInput {
  platform: AdCreativePlatform
  ads: readonly AdUploadSheetAd[]
  /** Meta 才要：主页编号（纯数字）与图片哈希（设计岗入库后的那张）。 */
  meta?: { page_id?: string | undefined; image_hash?: string | undefined }
  /** 品牌禁用词（WP314 的校验再查一遍）。 */
  banned_terms?: readonly string[]
}

/** 上传表生成器的形状（就是 WP314 的 `buildAdUploadBundle`；测试里可以换）。 */
export type AdUploadBundleBuilder = (input: BuildAdUploadInput) => AdUploadBundle

/** 一轮新文案 → 「新建广告」的 op。 */
export function creativeUploadOps(input: CreativeSheetInput): CreateAdOp[] {
  const ops: CreateAdOp[] = []
  for (const ad of input.ads) {
    const base = {
      kind: 'create_ad' as const,
      campaign: ad.campaign,
      ad_group: ad.ad_group,
      ...(ad.campaign_id === undefined ? {} : { campaign_id: ad.campaign_id }),
      ...(ad.ad_group_id === undefined ? {} : { ad_group_id: ad.ad_group_id }),
      final_url: ad.final_url ?? '',
    }
    if (input.platform === 'google') {
      ops.push({ ...base, google: { headlines: ad.headlines, descriptions: ad.descriptions } })
      continue
    }
    const n = Math.max(ad.headlines.length, ad.descriptions.length)
    for (let i = 0; i < n; i += 1) {
      const title = ad.headlines.length === 0 ? undefined : ad.headlines[i % ad.headlines.length]
      const body =
        ad.descriptions.length === 0 ? '' : (ad.descriptions[i % ad.descriptions.length] ?? '')
      ops.push({
        ...base,
        meta: {
          ad_name: `${ad.ad_group} · 新文案 ${i + 1}`,
          body,
          ...(title === undefined ? {} : { title }),
          page_id: input.meta?.page_id ?? '',
          ...(input.meta?.image_hash === undefined || input.meta.image_hash === ''
            ? {}
            : { image_hash: input.meta.image_hash }),
        },
      })
    }
  }
  return ops
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 字节 → base64（纯函数，不靠 Node 的 Buffer）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += b === undefined ? '=' : B64[(n >> 6) & 63]
    out += c === undefined ? '=' : B64[n & 63]
  }
  return out
}

/** 一轮新文案 → 给人下载的上传表（WP314 生成器出的）。 */
export function creativeUploadSheet(
  input: CreativeSheetInput,
  build: AdUploadBundleBuilder = buildAdUploadBundle,
): AdUploadSheet {
  const ops = creativeUploadOps(input)
  const bundle = build({
    platform: input.platform,
    ops,
    ...(input.banned_terms === undefined ? {} : { context: { banned_terms: input.banned_terms } }),
  })
  const files: AdUploadSheetFile[] = bundle.files.map((f) => ({
    name: f.name,
    content_type: f.mime,
    ...(typeof f.content === 'string' ? { text: f.content } : { base64: bytesToBase64(f.content) }),
    ...(f.paste_text === undefined ? {} : { paste_text: f.paste_text }),
    upload_from: f.upload_from,
  }))
  return {
    platform: input.platform,
    ok: bundle.ok,
    files,
    sentence: bundle.summary.sentence,
    fingerprint: bundle.fingerprint,
    problems: bundle.problems.map((p) => p.message),
    ads: ops.length,
  }
}

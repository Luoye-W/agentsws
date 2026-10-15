/**
 * WP316：上传表 ↔ 卡面（`after.form === 'ads_sheet'`）。
 *
 * 卡上带的就是批了之后插件要传的那几份**原样字节**（base64）+ 每份的指纹 + 整份的指纹。
 * 执行前按卡上的字节再算一遍，对不上就不传（审批绑的是这一份，被改过的不算批过）。
 *
 * Meta 用「复制粘贴」那一份制表符文字（WP314：优先 `paste_text`；WP313：文字表走粘贴），
 * 所以卡上 Meta 的原表是 `.tsv` 文字，给人下载的也是这一份。
 */
import {
  type AdUploadBundle,
  type AdUploadFile,
  bundleFingerprint,
  sha256Hex,
} from '@agentsws/ads-core'
import { base64ToBytes, bytesToBase64 } from '@agentsws/browser-action'
import {
  ADS_SHEET_FORM,
  type AdsSheetCardAfter,
  type AdsSheetCardFile,
  type AdsSheetPreviewRow,
} from '@agentsws/contracts'

const isText = (mime: string): boolean => /^text\//iu.test(mime)

/** 一份要上传的表 → 卡上那一格（Meta 换成粘贴用的文字）。 */
export function cardFileOf(file: AdUploadFile): AdsSheetCardFile {
  const meta = file.paste_text !== undefined
  const name = meta ? file.name.replace(/\.[^.]+$/u, '.tsv') : file.name
  const mime = meta ? 'text/tab-separated-values' : file.mime
  const content = meta ? (file.paste_text as string) : file.content
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return {
    name,
    mime,
    sheet: file.sheet,
    base64: bytesToBase64(bytes),
    fingerprint: `sha256:${sha256Hex(bytes)}`,
    bytes: bytes.byteLength,
  }
}

/** 整份的指纹（与 `ads-core` 的 `bundleFingerprint` 同一个算法，按卡上这几份算）。 */
export function cardFingerprint(files: readonly AdsSheetCardFile[]): string {
  return bundleFingerprint(
    files.map((f) => {
      const bytes = base64ToBytes(f.base64)
      return {
        name: f.name,
        mime: f.mime,
        content: isText(f.mime) ? new TextDecoder().decode(bytes) : bytes,
        sheet: f.sheet as AdUploadFile['sheet'],
        upload_from: '',
        headers: [],
        rows: [],
      }
    }),
  )
}

/** 执行前那一道：卡上的每份字节与它的指纹对得上、整份指纹也对得上。 */
export function checkCardFiles(
  after: Partial<AdsSheetCardAfter>,
): { ok: true; files: AdsSheetCardFile[] } | { ok: false; why: string } {
  const files = Array.isArray(after._files) ? after._files : []
  if (files.length === 0) return { ok: false, why: '卡上没有上传表，插件没东西可传。' }
  for (const f of files) {
    let bytes: Uint8Array
    try {
      bytes = base64ToBytes(f.base64)
    } catch {
      return { ok: false, why: `上传表「${f.name}」读不出来，没传。` }
    }
    if (`sha256:${sha256Hex(bytes)}` !== f.fingerprint)
      return { ok: false, why: `上传表「${f.name}」和批的时候不一样（被改过），没传。` }
  }
  const want = after.fingerprint ?? (after as { _fingerprint?: string })._fingerprint
  if (want !== undefined && cardFingerprint(files) !== want)
    return { ok: false, why: '上传表和批的时候不是同一份（指纹对不上），没传。' }
  return { ok: true, files }
}

/** 出卡用：一张上传表的 `after`（下划线开头的几格不上键值对，工作台换卡身画）。 */
export function sheetCardAfter(input: {
  bundle: AdUploadBundle
  platform: 'google' | 'meta'
  platform_label?: string
  account_id: string
  account_name?: string
  ops: readonly unknown[]
  extra?: Partial<AdsSheetCardAfter>
}): AdsSheetCardAfter {
  const files = input.bundle.files.map(cardFileOf)
  const rows: AdsSheetPreviewRow[] = input.bundle.summary.rows.map((r) => ({
    action: r.action,
    level: r.level,
    name: r.name,
    ...(r.before === undefined ? {} : { before: r.before }),
    ...(r.after === undefined ? {} : { after: r.after }),
  }))
  const warnings = input.bundle.problems
    .filter((p) => p.severity === 'warning')
    .map((p) => p.message)
  return {
    form: ADS_SHEET_FORM,
    platform: input.platform,
    ...(input.platform_label === undefined ? {} : { platform_label: input.platform_label }),
    account_id: input.account_id,
    ...(input.account_name === undefined ? {} : { account_name: input.account_name }),
    sentence: input.bundle.summary.sentence,
    rows,
    ...(warnings.length === 0 ? {} : { warnings }),
    fingerprint: cardFingerprint(files),
    ...input.extra,
    _files: files,
    _ops: [...input.ops],
  }
}

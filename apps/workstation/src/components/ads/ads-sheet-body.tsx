/**
 * WP316（docs/101 §5.1② 第 3 步）：上传表 / 开始投放 / 撤销卡的卡身（`after.form === 'ads_sheet'`）。
 *
 * 一句白话 + 表格预览（最多 6 行，多的写「还有 N 条」）+ 可下载的原表（就是批了插件要传的那一份）。
 * 界面少字：本地检查的提醒收进问号；「批了之后会怎样」也进问号。
 */
import { ADS_SHEET_FORM, type AdsSheetCardAfter } from '@agentsws/contracts'
import { Download } from 'lucide-react'
import type { ReactNode } from 'react'
import { InfoTip } from '@/components/design'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 这张卡是不是上传表 / 开始投放 / 撤销卡（payload 是 staged_change 那一份）。 */
export function isAdsSheetPayload(p: unknown): p is { after: AdsSheetCardAfter } {
  return isRecord(p) && isRecord(p.after) && p.after.form === ADS_SHEET_FORM
}

const PREVIEW_ROWS = 6

/** 卡上的原表存成文件（浏览器里存，不经任何第三方）。 */
function save(file: NonNullable<AdsSheetCardAfter['_files']>[number]): void {
  const bin = atob(file.base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  URL.revokeObjectURL(url)
}

export function AdsSheetBody({ payload }: { payload: { after: AdsSheetCardAfter } }): ReactNode {
  const { t } = useApp()
  const after = payload.after
  const rows = after.rows.slice(0, PREVIEW_ROWS)
  const more = after.rows.length - rows.length
  const files = after._files ?? []
  const warnings = after.warnings ?? []
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="ads-sheet-body">
      <p className="text-sm leading-6 text-ws-body" data-testid="ads-sheet-sentence">
        {after.sentence}
      </p>
      {rows.length === 0 ? null : (
        <table className="w-full text-left text-[13px]" data-testid="ads-sheet-rows">
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.action}|${r.level}|${r.name}`}
                className="border-b border-ws-border last:border-0"
              >
                <td className="py-1 pr-2 whitespace-nowrap text-ws-muted-fg">{r.action}</td>
                <td className="py-1 pr-2 whitespace-nowrap text-ws-muted-fg">{r.level}</td>
                <td className="py-1 pr-2">{r.name}</td>
                <td className="py-1 text-right whitespace-nowrap tabular-nums">
                  {r.before === undefined ? (r.after ?? '') : `${r.before} → ${r.after ?? ''}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-ws-muted-fg">
        {more > 0 ? <span>{t('adsc.sheet.more', { n: more })}</span> : null}
        {files.map((f) => (
          <button
            key={f.name}
            type="button"
            data-testid="ads-sheet-download"
            onClick={() => save(f)}
            className="inline-flex items-center gap-1 rounded-md bg-ws-surface px-2 py-1 font-medium text-ws-body hover:bg-accent"
          >
            <Download className="size-3.5" aria-hidden />
            {files.length === 1 ? t('adsc.sheet.download') : f.name}
          </button>
        ))}
        {files.length === 0 ? null : (
          <InfoTip text={t('adsc.sheet.download.hint')} testId="ads-sheet-hint">
            <span className="cursor-help">?</span>
          </InfoTip>
        )}
        {warnings.length === 0 ? null : (
          <InfoTip text={warnings.join('\n')} testId="ads-sheet-warnings">
            <span className="cursor-help text-ws-warn">
              {t('adsc.sheet.warnings', { n: warnings.length })}
            </span>
          </InfoTip>
        )}
      </div>
    </div>
  )
}

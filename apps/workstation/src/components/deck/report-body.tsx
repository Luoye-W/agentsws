/**
 * WP331（决策 691）：**报告**报表块的主体——通用的，不认平台、不认是周报还是日报。
 *
 * AI 用「发布报告」工具发的那一份（标题、周期、Markdown 正文、第几版）。界面少字（36 §7）：
 * 一行周期（第 2 版起带版号）+ 右上两个小图标（复制整份 / 导出 .md）+ 正文（长的先收着一截，点开看全）。
 * 正文走工作台唯一的安全 Markdown（不解析 HTML、不加载图片、链接只认 http(s)）。
 */
import type { ReportPayload } from '@agentsws/contracts'
import { Check, ChevronDown, ChevronUp, Copy, Download } from 'lucide-react'
import { useState } from 'react'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** payload 是不是一份报告（看形状，不看卡的 kind）。 */
export function isReport(payload: unknown): payload is ReportPayload {
  return (
    isRecord(payload) &&
    payload.kind === 'report' &&
    typeof payload.markdown === 'string' &&
    typeof payload.title === 'string'
  )
}

/** 正文超过这么多字先收着一截。 */
const FOLD_CHARS = 1200

/** 文件名：标题去掉文件名里不能有的字。 */
export function reportFilename(p: Pick<ReportPayload, 'title'>): string {
  const base = p.title
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `${base === '' ? 'report' : base.slice(0, 80)}.md`
}

/** 导出 `.md`（浏览器下载；不经服务端，内容就是卡上那一份）。 */
function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const ICON_BTN =
  'inline-flex size-7 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-surface hover:text-ws-fg'

export function ReportBody({ payload }: { payload: ReportPayload }): React.ReactNode {
  const { t } = useApp()
  const [copied, setCopied] = useState(false)
  const long = payload.markdown.length > FOLD_CHARS
  const [open, setOpen] = useState(!long)
  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="report">
      <div className="flex items-center gap-2">
        <span className="ws-num min-w-0 flex-1 truncate text-xs text-ws-muted-fg">
          {payload.period}
          {payload.version > 1 ? ` · ${t('report.version', { n: String(payload.version) })}` : ''}
        </span>
        <button
          type="button"
          className={ICON_BTN}
          aria-label={t('report.copy')}
          title={t('report.copy')}
          data-testid="report-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(payload.markdown).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
        <button
          type="button"
          className={ICON_BTN}
          aria-label={t('report.export')}
          title={t('report.export')}
          data-testid="report-export"
          onClick={() => download(reportFilename(payload), payload.markdown)}
        >
          <Download className="size-4" />
        </button>
      </div>
      <div className={cn('relative', open ? '' : 'max-h-64 overflow-hidden')}>
        <SafeMarkdown text={payload.markdown} variant="article" testId="report-markdown" />
        {open ? null : (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-ws-card to-transparent" />
        )}
      </div>
      {long ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 self-start text-xs text-ws-muted-fg hover:text-ws-fg"
          data-testid="report-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? t('report.less') : t('report.more')}
        </button>
      ) : null}
    </div>
  )
}

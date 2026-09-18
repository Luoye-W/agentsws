/**
 * WP97（36 §11，`docs/upstream/sidebar-compare.md` #13）：**Office 预览**——
 * 知识库里一份 Word / Excel / PPT，点一下在第三栏看得见，不用先下载下来。
 *
 * 这是 WP95 那张注册表的**第一个真入口**：它是第一个既有 `matches` 又真被
 * `resolvePanel()` 挑中的面板（"点一份文件 → 第三栏开预览"，`rail-state.tsx`
 * 的 `openAddress`）。变更审阅虽然也声明了 `matches`，但没有人从地址开它。
 *
 * ## 体不借官方（Luoye 定，2026-09-18）
 *
 * 官方 0.1.6-alpha.2 那一条是 `dsh-office-to-pdf` → `@deepseek-ai/libreoffice-kit`：
 * 在**服务端**起一套 LibreOffice 把文件转成 PDF，再在侧边栏里渲染 PDF。
 * WP93 已经按 16 §3 最严解释把那五个平台包 `ignoredOptionalDependencies` 掉了
 * （本机那一个 259 MB）。我们反过来：**字节原样下发，浏览器里纯 JS 渲染**。
 *
 * ## CSP 这道墙（13 §5，`apps/desktop/src/csp.ts`）
 *
 * 壳给所有响应盖 `default-src 'self'`，而 CSP 的回落规则让它一口气管住四样东西。
 * 选库时这张表比"哪个排版还原得好"重要得多：
 *
 * | 被管住的 | 后果 | 这一版怎么办 |
 * |---|---|---|
 * | `script-src`（没有 `'unsafe-eval'`） | 库里只要执行到 `eval` / `new Function` 就抛 | **mammoth 因此出局**（它的浏览器包里 8 处 `new Function`）；三个在用的库实测零处 |
 * | `worker-src` → `child-src` → `default-src 'self'` | 同源 blob 的 Worker 也起不来 | 解析**全在主线程**，配一道 5 秒的闸（`office/deadline.ts`） |
 * | `style-src`（没有 `'unsafe-inline'`） | `<style>` 与 `style="…"` 都不生效 | 表格与 PPT 我们自己画（本来就不需要）；Word 那一档退成"结构 + 文字"，见 `office/word-view.tsx` |
 * | `img-src`（不含 `blob:`） | 文档里内嵌的图片在壳里显示不出来 | 照渲染、照回收；显示不出来时 `alt` 里有一句人话。**要让它显示得改壳的 CSP，那是 Luoye 的一道题**，不在这个 WP 里动 |
 *
 * 三个库都逐个核实过（许可证 / eval / 外链 / 体积，数字进报告）：
 * `docx-preview@0.4.0`（Apache-2.0）、`exceljs@4.4.0`（MIT，**WP99 换掉了
 * `xlsx@0.18.5`**——理由见 `office/sheet-view.tsx` 顶上）、
 * `jszip@3.10.2`（MIT OR GPL-3.0-or-later，取 MIT）。
 *
 * ## 数据边界（40 §1.2）
 *
 * **文件内容一个字节都不落到这台电脑上**：不写本机存储（第三栏那一份只有结构，#5；
 * 碰得到本机存储的只有 `lib/` 下那三个文件，`test/local-cache.test.ts` 钉着）、
 * 不进事件日志、不进 react-query 的持久层（我们没开）。
 * 它活在一个 `Blob` 里，面板一关就没了。图片的 blob URL 由各自的视图 `revoke`。
 */

import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useCallback, useState } from 'react'
import { StatusPill, WsCard, WsTag } from '@/components/design'
import { PanelError } from '@/components/rail/panel-error'
import { officeKindOf, parseFileAddress } from '@/components/rail/panels/office/address'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getKnowledgeSourceFile,
  listKnowledgeSources,
  PREVIEW_MAX_BYTES,
  type SourceFileResult,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 三个视图各自一个 chunk：开 Word 的人不该顺手把近 1 MB 的 exceljs 下下来。 */
const WordView = lazy(async () => {
  const m = await import('@/components/rail/panels/office/word-view')
  return { default: m.WordView }
})
const SheetView = lazy(async () => {
  const m = await import('@/components/rail/panels/office/sheet-view')
  return { default: m.SheetView }
})
const SlidesView = lazy(async () => {
  const m = await import('@/components/rail/panels/office/slides-view')
  return { default: m.SlidesView }
})

/** 1.2 MB / 340 KB 这种给人看的写法（表格动辄几 MB，写字节数没人读得出大小）。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** 下载原件：拿 blob 再造一个临时链接点一下（与知识库页导出同一条路）。 */
async function download(source_id: string, fallbackName: string): Promise<void> {
  // `limit: Infinity`：下载不受预览那道 20 MB 的闸管——那道闸管的是"画不画"
  const got = await getKnowledgeSourceFile(source_id, { limit: Number.POSITIVE_INFINITY })
  if (got.blob === undefined) return
  const url = URL.createObjectURL(got.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = got.filename === '' ? fallbackName : got.filename
  a.click()
  URL.revokeObjectURL(url)
}

function Body({
  filename,
  file,
  onFail,
}: {
  filename: string
  file: SourceFileResult
  onFail(): void
}): ReactNode {
  const { t } = useApp()
  // 画不出来的两种都用**注意档的状态胶囊**（WP96 的 `StatusPill`）：
  // 它们不是错误（文件好好的），只是这一栏画不了——用红档会让人以为文件坏了
  if (file.too_large || file.blob === undefined)
    return (
      <StatusPill tone="warn" data-testid="rail-office-too-large">
        {t('rail.office.too_large', { limit: humanSize(PREVIEW_MAX_BYTES) })}
      </StatusPill>
    )
  const kind = officeKindOf(filename)
  if (kind === undefined)
    return (
      <StatusPill tone="neutral" data-testid="rail-office-unsupported">
        {t('rail.office.unsupported')}
      </StatusPill>
    )
  const blob = file.blob
  return (
    <Suspense fallback={<Skeleton className="h-32 w-full" />}>
      {kind === 'word' ? (
        <WordView blob={blob} onFail={onFail} />
      ) : kind === 'sheet' ? (
        // 文件名传下去只为了分 `.csv` 与 `.xlsx` 两条读法（WP99：csv 自己按
        // RFC 4180 解，xlsx 走 exceljs）——视图不拿它做别的
        <SheetView blob={blob} filename={filename} onFail={onFail} />
      ) : (
        <SlidesView blob={blob} onFail={onFail} />
      )}
    </Suspense>
  )
}

export function OfficePreviewPanel({ address }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  // 渲染塌了（超时 / 文件坏了）之后头上那句提示要换成"下载查看"——
  // 视图各自知道自己塌了，但"接下来怎么办"这句话只该有一处
  const [failed, setFailed] = useState(false)
  const onFail = useCallback(() => {
    setFailed(true)
  }, [])

  const parsed = address === undefined ? undefined : parseFileAddress(address)
  const source_id = parsed?.source_id

  // 源清单：拿"来源是知识库上传还是邮件"与文件名的兜底。
  // 与文件字节分成两条 query：清单是能缓存的元数据，字节不缓存（40 §1.2）
  const sources = useQuery({
    queryKey: ['knowledge-sources'],
    queryFn: () => listKnowledgeSources(),
    enabled: source_id !== undefined,
  })
  const file = useQuery({
    queryKey: ['knowledge-source-file', source_id],
    queryFn: () => getKnowledgeSourceFile(source_id as string),
    enabled: source_id !== undefined,
    // 取回来的是文件内容：不缓存、不重取。一份 Excel 在内存里躺着的时间越短越好
    gcTime: 0,
    staleTime: 0,
    retry: false,
  })

  if (source_id === undefined)
    return (
      <p className="text-sm text-ws-muted-fg" data-testid="rail-office-no-file">
        {t('rail.office.no_file')}
      </p>
    )

  const source = sources.data?.find((s) => s.id === source_id)
  const filename = file.data?.filename ?? parsed?.filename ?? source_id
  const origin =
    source === undefined ? 'unknown' : source.kind === 'upload' ? 'upload' : source.kind

  return (
    <div className="space-y-3" data-testid="rail-office" data-source={source_id}>
      {/* 文件那一头是一张卡（WP96 的 `WsCard`）：文件名、来源、大小、下载 */}
      <WsCard className="flex flex-wrap items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="ws-display break-all text-sm" data-testid="rail-office-name">
            {filename}
          </p>
          <p
            className="flex flex-wrap items-center gap-1.5 text-xs text-ws-muted-fg"
            data-testid="rail-office-meta"
          >
            <WsTag>{t(`rail.office.origin.${origin}`)}</WsTag>
            {file.data === undefined ? null : (
              <span className="ws-num">{humanSize(file.data.size)}</span>
            )}
          </p>
        </div>
        {/*
          这里**不用** WP96 的 `GoButton`：那个 → 圆钮是"离开队列进详情"的出口
          （`deck-card.tsx` 里那句），而这一个是一个动作，还得带下载的图标与文字。
          动作按钮在 WP96 之后仍是 shadcn 的 `Button`（`deck-action-bar.tsx` 同）。
        */}
        <Button
          size="sm"
          variant="outline"
          data-testid="rail-office-download"
          onClick={() => {
            void download(source_id, filename)
          }}
        >
          <Download aria-hidden className="size-3.5" />
          {t('rail.office.download')}
        </Button>
      </WsCard>
      {failed ? (
        <StatusPill tone="warn" data-testid="rail-office-fallback">
          {t('rail.office.download_instead')}
        </StatusPill>
      ) : null}
      {file.isPending ? <Skeleton className="h-32 w-full" /> : null}
      {file.error !== null ? <PanelError error={file.error} /> : null}
      {file.data === undefined ? null : (
        <Body filename={filename} file={file.data} onFail={onFail} />
      )}
    </div>
  )
}

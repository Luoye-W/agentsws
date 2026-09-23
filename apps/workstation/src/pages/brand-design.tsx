/**
 * 品牌设置里的「设计规范」页（71 §4，WP122）。
 *
 * 上半**可视化**（色板、字样、间距与圆角、按钮 / 卡片样例、logo 深浅底），
 * 下半是 `DESIGN.md` 的**原文编辑器**——左改右预览是同一份文件的两种看法，
 * 不是两份数据。所以这一页只有一个 query（`getBrandDesign`），两个 tab 读它的
 * 两格（`profile` 与 `markdown`），永远不会出现"色块和文件里的色值对不上"。
 *
 * 三条界面纪律：
 *
 * 1. **空状态说人话**（36 §3）。还没抓过就是一句「还没有设计规范」+ 两个入口，
 *    不是一张空色板。
 * 2. **抓那一下是 outbound**，所以它有一个明确的"正在读官网的样式…"而不是
 *    一个转圈：用户得知道我们正在敲他自己的服务器。
 * 3. **冲突不替用户判**。有几处不一样就在顶上说几处，点开在色块旁边并排画出来。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { MarkdownPreview } from '@/components/design-md/markdown-preview'
import { countConflicts, designSummary, TokensView } from '@/components/design-md/tokens-view'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  editBrandDesignToken,
  extractBrandDesign,
  getBrandDesign,
  ingestBrandDesignFile,
  listBrandDesignRevisions,
  replaceBrandDesign,
  UPLOAD_ACCEPT,
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  uploadKnowledgeSource,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function BrandDesignPage(): React.ReactElement {
  const { t } = useApp()
  const qc = useQueryClient()
  const doc = useQuery({ queryKey: ['brand-design'], queryFn: getBrandDesign })
  const revisions = useQuery({
    queryKey: ['brand-design', 'revisions'],
    queryFn: listBrandDesignRevisions,
  })
  const [draft, setDraft] = useState<string | undefined>(undefined)

  // 原文编辑器的草稿跟着服务端那一份走，**但只在用户没动过的时候**——
  // 正在打字的时候被一次后台刷新覆盖掉，是这一类编辑器最常见的伤人方式。
  useEffect(() => {
    if (draft === undefined && doc.data != null) setDraft(doc.data.markdown)
  }, [doc.data, draft])

  const extract = useMutation({
    mutationFn: async () => extractBrandDesign({}),
    onSuccess: async () => {
      setDraft(undefined)
      await qc.invalidateQueries({ queryKey: ['brand-design'] })
    },
  })
  const save = useMutation({
    mutationFn: async (markdown: string) => replaceBrandDesign(markdown),
    onSuccess: async () => {
      setDraft(undefined)
      await qc.invalidateQueries({ queryKey: ['brand-design'] })
    },
  })
  /** 改一格（WP122b 交付 ③）：成功后可视化那一半当场跟着变——样例是实时渲染的。 */
  const editToken = useMutation({
    mutationFn: async (input: { path: string; value: string }) =>
      editBrandDesignToken(input.path, input.value),
    onSuccess: async () => {
      setDraft(undefined)
      await qc.invalidateQueries({ queryKey: ['brand-design'] })
    },
  })
  /**
   * 传一份品牌手册进来（71 §2 第二条）。走的是**知识上传那一条路**（WP99）——
   * 文件先进知识库，再拿它的 id 去读；不另开一条上传通道，两道闸（扩展名与
   * 大小）于是与知识库那边永远是同一份。
   */
  const fileRef = useRef<HTMLInputElement | null>(null)
  const ingest = useMutation({
    mutationFn: async (file: File) => {
      const source = await uploadKnowledgeSource(file)
      return ingestBrandDesignFile(source.id)
    },
    onSuccess: async () => {
      setDraft(undefined)
      await qc.invalidateQueries({ queryKey: ['brand-design'] })
    },
  })
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  /**
   * 前端那一道预检，与知识库上传那边**同一份判据、同一批 i18n key**。
   * 不是安全闸（真闸在服务端），是别让人白等：一份 300 MB 的扫描件传上去
   * 再被拒，他已经等了两分钟。
   */
  const precheck = (file: File): string | undefined => {
    const dot = file.name.lastIndexOf('.')
    const ext = dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase()
    if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(ext))
      return t('knowledge.upload.bad_kind', { kinds: UPLOAD_EXTENSIONS.join(' / ') })
    if (file.size === 0) return t('knowledge.upload.empty')
    if (file.size > UPLOAD_MAX_BYTES)
      return t('knowledge.upload.too_large', {
        limit: Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024),
      })
    return undefined
  }

  /**
   * 传手册没成有**三种长相**，都得说人话：
   * ① 前端预检当场拦下（不收的扩展名 / 空文件 / 太大）；
   * ② 上传或读取那一跳抛了（网络、服务端那六道闸）；
   * ③ **HTTP 200 但 `status: 'failed'`**——文件收到了，却认不出里面有规范。
   *    这一种最容易漏：请求是成功的，界面上于是什么都没发生，人只当没点上。
   */
  const ingestError =
    fileError ??
    (ingest.error === null ? undefined : ingest.error.message) ??
    (ingest.data?.status === 'failed'
      ? (ingest.data.failure ?? t('design.md.ingest.failed'))
      : undefined)

  if (doc.isLoading) return <Skeleton className="h-64 w-full" />

  const current = doc.data ?? undefined
  const summary = current === undefined ? undefined : designSummary(current.profile)
  const conflicts = current === undefined ? 0 : countConflicts(current.profile)

  return (
    <div className="flex flex-col gap-4" data-testid="design-md-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-lg">{t('design.md.title')}</h1>
          <p className="max-w-xl text-sm text-ws-muted-fg">{t('design.md.subtitle')}</p>
          <p className="text-xs text-ws-muted-fg" data-testid="design-md-summary">
            {summary === undefined ? t('design.md.summary.none') : t('design.md.summary', summary)}
          </p>
          {conflicts === 0 ? null : (
            <p className="text-ws-warn text-xs" data-testid="design-md-conflicts">
              {t('design.md.conflicts', { count: conflicts })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={extract.isPending}
            onClick={() => extract.mutate()}
            data-testid="design-md-extract"
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {extract.isPending ? t('design.md.extracting') : t('design.md.extract')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept={UPLOAD_ACCEPT}
            className="hidden"
            data-testid="design-md-file"
            onChange={(e) => {
              const file = e.target.files?.[0]
              // 立刻清空：同一份文件选第二次也要能触发 change
              e.target.value = ''
              if (file === undefined) return
              const bad = precheck(file)
              setFileError(bad)
              if (bad === undefined) ingest.mutate(file)
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={ingest.isPending}
            onClick={() => fileRef.current?.click()}
            data-testid="design-md-upload"
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {ingest.isPending ? t('design.md.ingesting') : t('design.md.upload')}
          </Button>
          {current === undefined ? null : (
            <Button variant="ghost" size="sm" asChild data-testid="design-md-download">
              <a
                href={`data:text/markdown;charset=utf-8,${encodeURIComponent(current.markdown)}`}
                download="DESIGN.md"
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t('design.md.download')}
              </a>
            </Button>
          )}
        </div>
      </header>

      {/* 传手册那一下没成：说清楚是哪一份、为什么。**不弹红框**——弹框会被关掉，
          关掉之后那一行字就再也找不回来了 */}
      {ingestError === undefined ? null : (
        <p className="text-ws-bad text-xs" data-testid="design-md-ingest-error">
          {ingestError}
        </p>
      )}

      {current === undefined ? (
        <Card className="p-6 text-sm text-ws-muted-fg" data-testid="design-md-empty">
          {t('design.md.empty')}
        </Card>
      ) : (
        <Tabs defaultValue="visual">
          <TabsList>
            <TabsTrigger value="visual">{t('design.md.tab.visual')}</TabsTrigger>
            <TabsTrigger value="source">{t('design.md.tab.source')}</TabsTrigger>
            <TabsTrigger value="history">{t('design.md.tab.history')}</TabsTrigger>
          </TabsList>

          <TabsContent value="visual" className="pt-4">
            <TokensView
              profile={current.profile}
              onEdit={async (path, value) => {
                // WP122b 交付 ③：小铅笔那一跳，走的就是 PATCH tokens 那个端点。
                // 失败原样抛回去，由 TokensView 就地留一行字（不弹框）。
                await editToken.mutateAsync({ path, value })
              }}
            />
          </TabsContent>

          {/* 原文：左改右预览。**同一份文件**，不是两份数据 */}
          <TabsContent value="source" className="pt-4">
            <div className="grid gap-3 lg:grid-cols-2">
              <Textarea
                className="min-h-[28rem] font-mono text-xs"
                value={draft ?? current.markdown}
                onChange={(e) => setDraft(e.target.value)}
                data-testid="design-md-source"
              />
              <div className="min-h-[28rem] overflow-auto rounded-md border border-ws-line p-3">
                <MarkdownPreview markdown={draft ?? current.markdown} />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-3">
              <Button
                size="sm"
                disabled={save.isPending || draft === undefined || draft === current.markdown}
                onClick={() => {
                  if (draft !== undefined) save.mutate(draft)
                }}
                data-testid="design-md-save"
              >
                {t('design.md.save')}
              </Button>
              <span className="text-xs text-ws-muted-fg">
                {t('design.md.saved', { revision: current.revision })}
              </span>
            </div>
          </TabsContent>

          <TabsContent value="history" className="pt-4">
            <ul className="flex flex-col gap-2" data-testid="design-md-history">
              {(revisions.data ?? [])
                .slice()
                .reverse()
                .map((r) => (
                  <li
                    key={r.revision}
                    className="flex items-baseline gap-3 border-ws-line border-b pb-2 text-sm last:border-0"
                  >
                    <span className="font-mono text-ws-muted-fg text-xs">#{r.revision}</span>
                    <span>{t(`design.md.rev.${r.reason}`)}</span>
                    <span className="text-ws-muted-fg text-xs">{r.note ?? ''}</span>
                    <span className="ml-auto text-ws-muted-fg text-xs">
                      {r.at.slice(0, 16).replace('T', ' ')}
                    </span>
                  </li>
                ))}
            </ul>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

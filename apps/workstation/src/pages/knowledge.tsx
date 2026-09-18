/**
 * 知识库（WP56）。五块，从上到下：
 *
 * 1. **导入 / 导出**——一个 `kefu-knowledge-pack/v1` 进来，整库出去。零锁定，
 *    也是 D 期迁移工具的地基（48 §4 #9）；
 * 2. **要复核的**——源页 / 文档改了、受管辖数值也变了的那几条。三选一（§4 #6）；
 * 3. **上传的文件**（WP97 列出来、**WP99 补上传与删除**）——拖进来或点一下选，
 *    传完立刻出现在下面那一列，点一条在第三栏预览；
 * 4. **缺口**——Agent 答不上来的问题，两种补法：贴链接 / 粘文字；
 * 5. **知识清单**——层、适用范围、时效一眼看完。
 *
 * 这一页不做编辑器：19 §4「写只经审批项」——改一条知识是一张卡的事，不是一个输入框的事。
 *
 * **上传那一块的三条**（WP99）：
 * - **一份一份传**，不并发：并发只会让进度条一起动、失败原因混在一起，
 *   而人真正想知道的是"哪一份没传上去、为什么"；
 * - **前端先拦**超大与不收的扩展名——这不是安全（谁都绕得过去，真闸在服务端），
 *   是别让人等：一份 300 MB 的文件传上去再被拒，人已经等了两分钟；
 * - **失败原因说人话**：服务端那六道闸每一道都带一句中文，原样显示出来。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileText, Trash2, Upload, UploadCloud } from 'lucide-react'
import { type DragEvent, useRef, useState } from 'react'
import { WsCard, WsTag } from '@/components/design'
import { GapRow } from '@/components/knowledge/gap-row'
import { RecheckCard } from '@/components/knowledge/recheck-card'
import {
  fileAddress,
  isLegacyOfficeFile,
  officeKindOf,
} from '@/components/rail/panels/office/address'
import { useRailState } from '@/components/rail/rail-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  answerKnowledgeGap,
  deleteKnowledgeSource,
  exportKnowledgePack,
  getKnowledgeSourceFile,
  importKnowledgePack,
  type KnowledgePackImportResult,
  type KnowledgeSource,
  listKnowledgeBoundaries,
  listKnowledgeCards,
  listKnowledgeGaps,
  listKnowledgeRechecks,
  listKnowledgeSources,
  resolveKnowledgeRecheck,
  UPLOAD_ACCEPT,
  UPLOAD_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  uploadKnowledgeSource,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/**
 * `knowledge/报价单.xlsx` / `blob://k1` → 给人看的那个名字。
 *
 * WP99 之后**优先用 `source.filename`**：上传那一档的 `ref` 是
 * `blob://knowledge/<工作区>/<sha256>.xlsx`，从里面切最后一段只会切出一串
 * 十六进制。这个函数留着，是给还没有 `filename` 的老行与数据目录那一档兜底。
 */
function nameOfSource(source: Pick<KnowledgeSource, 'ref' | 'filename'>): string {
  if (source.filename !== undefined && source.filename !== '') return source.filename
  const parts = source.ref.split(/[/\\]/)
  return parts[parts.length - 1] ?? source.ref
}

/** 上传队列里的一格。`error` 是服务端那句人话，原样显示。 */
interface UploadItem {
  name: string
  state: 'waiting' | 'sending' | 'done' | 'failed'
  error?: string
}

export function KnowledgePage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const rail = useRailState()
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const [imported, setImported] = useState<KnowledgePackImportResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // WP99：上传队列（一份一份传）与拖拽高亮
  const [queue, setQueue] = useState<UploadItem[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)

  const cards = useQuery({ queryKey: ['knowledge-cards'], queryFn: () => listKnowledgeCards() })
  const rechecks = useQuery({
    queryKey: ['knowledge-rechecks'],
    queryFn: () => listKnowledgeRechecks(),
  })
  const gaps = useQuery({ queryKey: ['knowledge-gaps'], queryFn: () => listKnowledgeGaps() })
  const boundaries = useQuery({
    queryKey: ['knowledge-boundaries'],
    queryFn: () => listKnowledgeBoundaries(),
  })
  // WP97：上传的原件清单。点一条 = 把第三栏开到这一份上（见下面那个 openFile）
  const sources = useQuery({
    queryKey: ['knowledge-sources'],
    queryFn: () => listKnowledgeSources(),
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['knowledge-cards'] })
    void client.invalidateQueries({ queryKey: ['knowledge-rechecks'] })
    void client.invalidateQueries({ queryKey: ['knowledge-gaps'] })
  }

  /** 传完一份就刷一次清单——"传完立刻出现在列表里"靠的就是这一句。 */
  const refreshSources = (): Promise<void> =>
    client.invalidateQueries({ queryKey: ['knowledge-sources'] })

  /**
   * 前端那一道预检。**不是安全闸**（谁都绕得过去，真闸在服务端那六道），
   * 是别让人白等：超大与不收的扩展名当场说，不占一次上传。
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
   * 一份一份传。
   *
   * 不并发：并发之后进度一起动、失败原因混在一起，而人真正要知道的是
   * "哪一份没上去、为什么"。每传完一份刷一次清单，于是列表是一份一份长出来的。
   */
  const upload = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    const start = queue.length
    setQueue((prev) => [
      ...prev,
      ...files.map((f) => ({ name: f.name, state: 'waiting' as const })),
    ])
    setBusy(true)
    const patch = (i: number, next: Partial<UploadItem>): void => {
      setQueue((prev) => prev.map((it, k) => (k === start + i ? { ...it, ...next } : it)))
    }
    for (const [i, file] of files.entries()) {
      const bad = precheck(file)
      if (bad !== undefined) {
        patch(i, { state: 'failed', error: bad })
        continue
      }
      patch(i, { state: 'sending' })
      try {
        await uploadKnowledgeSource(file)
        patch(i, { state: 'done' })
        await refreshSources()
      } catch (e: unknown) {
        patch(i, { state: 'failed', error: e instanceof Error ? e.message : String(e) })
      }
    }
    setBusy(false)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragging(false)
    void upload([...(e.dataTransfer?.files ?? [])])
  }

  const remove = useMutation({
    mutationFn: (id: string) => deleteKnowledgeSource(id),
    onSuccess: () => {
      void refreshSources()
    },
  })

  const resolve = useMutation({
    mutationFn: (input: { id: string; resolution: 'unchanged' | 'adopt_new' | 'ignore' }) =>
      resolveKnowledgeRecheck(input.id, input.resolution),
    onSuccess: refresh,
  })
  const answer = useMutation({
    mutationFn: (input: { id: string; answer: string }) =>
      answerKnowledgeGap(input.id, input.answer),
    onSuccess: refresh,
  })
  const doImport = useMutation({
    mutationFn: (file: File) => importKnowledgePack(file),
    onSuccess: (result) => {
      setImported(result)
      setFailed(null)
      refresh()
    },
    onError: (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)),
  })

  /**
   * 导出：拿 blob 再造一个临时链接点一下。
   *
   * 不直接把 `<a href="/v1/knowledge/export">` 摆上去——那一发不带
   * `Authorization` 与 `X-Assignment`，在浏览器档会 401。
   */
  /**
   * WP97（36 §11 #13）：点一份上传的文件。
   *
   * **不在这里判"这是不是 Office 文件"**——把地址交给注册表，
   * `resolvePanel()` 按 `priority` → pattern 长度 → 注册顺序排一遍，
   * `canOpen()` 一票否决（`rail-state.tsx` 的 `openAddress`）。判了就等于把
   * 那套排序在调用点抄第二遍，而第二遍迟早和第一遍不一致。
   *
   * 没有面板认领（.zip / .pdf / 飞书文档那种没有本机原件的）→ 退回下载。
   */
  const openFile = (source_id: string, name: string): void => {
    if (rail.openAddress(fileAddress(source_id, name))) return
    void (async () => {
      const got = await getKnowledgeSourceFile(source_id, { limit: Number.POSITIVE_INFINITY })
      if (got.blob === undefined) return
      const url = URL.createObjectURL(got.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = got.filename === '' ? name : got.filename
      a.click()
      URL.revokeObjectURL(url)
    })()
  }

  const doExport = async (): Promise<void> => {
    const blob = await exportKnowledgePack()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'knowledge-pack.zip'
    a.click()
    URL.revokeObjectURL(url)
  }

  // 只列 `kind: 'upload'` 的：飞书文档 / 网页那几种源没有本机原件，
  // 列出来只会点进一个永远 404 的预览
  const uploads = (sources.data ?? []).filter((s) => s.kind === 'upload')

  const statementOf = (cardId: string): string | undefined =>
    cards.data?.find((c) => c.id === cardId)?.statement

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('knowledge.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".zip"
              className="hidden"
              data-testid="knowledge-import-input"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file !== undefined) doImport.mutate(file)
                e.target.value = ''
              }}
            />
            <Button
              size="sm"
              variant="outline"
              data-testid="knowledge-import"
              disabled={doImport.isPending}
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="mr-1 size-4" />
              {t('knowledge.import')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="knowledge-export"
              onClick={() => void doExport()}
            >
              <Download className="mr-1 size-4" />
              {t('knowledge.export')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('knowledge.pack_note')}</p>
          {imported === null ? null : (
            <p className="text-xs" data-testid="knowledge-import-result">
              {t('knowledge.import_result', {
                imported: imported.imported,
                activated: imported.activated,
                proposed: imported.proposed,
              })}
            </p>
          )}
          {failed === null ? null : <p className="text-xs text-destructive">{failed}</p>}
        </CardContent>
      </Card>

      {rechecks.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        (rechecks.data ?? []).map((recheck) => {
          const statement = statementOf(recheck.card_id)
          return (
            <RecheckCard
              key={recheck.id}
              recheck={recheck}
              busy={resolve.isPending}
              {...(statement === undefined ? {} : { statement })}
              onResolve={(resolution) => resolve.mutate({ id: recheck.id, resolution })}
            />
          )
        })
      )}

      <Card data-testid="knowledge-sources">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('knowledge.sources.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/*
            WP99：上传区。拖进来，或点"选择文件"。
            用一个 `div` 接拖拽 + 一个真按钮接点击，而不是把整块做成 `<label>`：
            读屏软件念一个包着说明文字的 label 只会把两件事读成一句。
          */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 这一块只接拖拽；点击那一路由下面的真按钮负责（键盘照样到得了） */}
          <div
            data-testid="knowledge-upload-drop"
            data-dragging={dragging ? 'yes' : 'no'}
            className={cn(
              'flex flex-col items-center gap-2 rounded-ws-card border border-dashed px-4 py-6 text-center',
              dragging ? 'border-ws-brand bg-ws-tint' : 'border-ws-line',
            )}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => {
              setDragging(false)
            }}
            onDrop={onDrop}
          >
            <UploadCloud aria-hidden className="size-6 text-ws-muted-fg" />
            <p className="text-sm text-ws-body">{t('knowledge.upload.hint')}</p>
            <p className="text-xs text-ws-muted-fg" data-testid="knowledge-upload-kinds">
              {t('knowledge.upload.kinds', {
                kinds: UPLOAD_EXTENSIONS.join(' / '),
                limit: Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024),
              })}
            </p>
            <input
              ref={uploadInput}
              type="file"
              multiple
              accept={UPLOAD_ACCEPT}
              className="hidden"
              data-testid="knowledge-upload-input"
              onChange={(e) => {
                void upload([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid="knowledge-upload"
              onClick={() => uploadInput.current?.click()}
            >
              <Upload aria-hidden className="mr-1 size-4" />
              {busy ? t('knowledge.upload.sending') : t('knowledge.upload.pick')}
            </Button>
          </div>

          {/* 一份一格：传到哪一步了、没传上去是为什么（服务端那句人话原样显示） */}
          {queue.length === 0 ? null : (
            <ul className="space-y-1 text-xs" data-testid="knowledge-upload-queue">
              {queue.map((item, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: 队列只往后追加、不排序不删——序号就是这一格的身份（同名文件可以传两次）
                  key={`${item.name}-${i}`}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`knowledge-upload-item-${i}`}
                  data-state={item.state}
                >
                  <span className="min-w-0 max-w-[16rem] truncate text-ws-body">{item.name}</span>
                  <WsTag>{t(`knowledge.upload.state.${item.state}`)}</WsTag>
                  {item.error === undefined ? null : (
                    <span className="text-destructive" data-testid={`knowledge-upload-error-${i}`}>
                      {item.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {sources.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : uploads.length === 0 ? (
            <p className="text-sm text-ws-muted-fg" data-testid="knowledge-sources-empty">
              {t('knowledge.sources.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {uploads.map((source) => {
                const name = nameOfSource(source)
                const previewable = officeKindOf(name) !== undefined
                // WP99：`.xls` / `.doc` / `.ppt` 换库之后解不动了，那一行要说清是
                // **格式太老**，不是"这一栏不管这种文件"（两句话对应的下一步不一样）
                const legacy = !previewable && isLegacyOfficeFile(name)
                return (
                  <li key={source.id}>
                    {/* 一份文件一张卡（WP96 的 `WsCard`）；卡可点，删除是卡右边一个单独的钮 */}
                    <WsCard className="flex items-center gap-1 p-0">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 px-4 py-3 text-left"
                        data-testid={`knowledge-source-${source.id}`}
                        onClick={() => {
                          openFile(source.id, name)
                        }}
                      >
                        <FileText aria-hidden className="size-4 shrink-0 text-ws-muted-fg" />
                        <span className="min-w-0 flex-1 truncate">{name}</span>
                        <WsTag>
                          {previewable
                            ? t('knowledge.sources.preview')
                            : legacy
                              ? t('knowledge.sources.legacy_only')
                              : t('knowledge.sources.download_only')}
                        </WsTag>
                      </button>
                      {/*
                        删除不做二次确认弹窗：21 的擦除是**软删 + 字节真删**，
                        而同一份文件再传一次就回来了（key 是内容 hash）。
                        为一个可复原的动作弹一个模态，只会让人下次闭着眼点确定。
                      */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mr-2 shrink-0"
                        disabled={remove.isPending}
                        aria-label={t('knowledge.sources.remove')}
                        data-testid={`knowledge-source-remove-${source.id}`}
                        onClick={() => remove.mutate(source.id)}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </WsCard>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('knowledge.gaps')}</CardTitle>
        </CardHeader>
        <CardContent>
          {(gaps.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('knowledge.gaps.empty')}</p>
          ) : (
            <ul>
              {(gaps.data ?? []).map((gap) => (
                <GapRow
                  key={gap.id}
                  gap={gap}
                  busy={answer.isPending}
                  onAnswer={(text) => answer.mutate({ id: gap.id, answer: text })}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card data-testid="knowledge-boundaries">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('knowledge.boundaries')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('knowledge.boundaries.note')}</p>
          <ul className="divide-y text-sm">
            {(boundaries.data ?? []).map((b) => (
              <li key={b.id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate">{b.label}</span>
                <Badge variant={b.answered ? 'secondary' : 'outline'}>
                  {b.answered ? t('knowledge.boundaries.answered') : t('knowledge.boundaries.open')}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('knowledge.cards')}</CardTitle>
        </CardHeader>
        <CardContent>
          {cards.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <ul className="divide-y text-sm">
              {(cards.data ?? []).map((card) => (
                <li key={card.id} className="flex items-start gap-2 py-2">
                  <Badge variant="outline">{t(`knowledge.layer.${card.layer}`)}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{card.subject.key}</p>
                    <p className="truncate text-xs text-muted-foreground">{card.statement}</p>
                  </div>
                  {card.stage === undefined || card.stage === 'both' ? null : (
                    <Badge variant="secondary">{t(`knowledge.stage.${card.stage}`)}</Badge>
                  )}
                  {card.verification_state === undefined ||
                  card.verification_state === 'fresh' ? null : (
                    <Badge variant="outline">
                      {t(`knowledge.verification.${card.verification_state}`)}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

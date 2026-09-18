/**
 * 知识库（WP56）。四块，从上到下：
 *
 * 1. **导入 / 导出**——一个 `kefu-knowledge-pack/v1` 进来，整库出去。零锁定，
 *    也是 D 期迁移工具的地基（48 §4 #9）；
 * 2. **要复核的**——源页 / 文档改了、受管辖数值也变了的那几条。三选一（§4 #6）；
 * 3. **缺口**——Agent 答不上来的问题，两种补法：贴链接 / 粘文字；
 * 4. **知识清单**——层、适用范围、时效一眼看完。
 *
 * 这一页不做编辑器：19 §4「写只经审批项」——改一条知识是一张卡的事，不是一个输入框的事。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileText, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { WsCard, WsTag } from '@/components/design'
import { GapRow } from '@/components/knowledge/gap-row'
import { RecheckCard } from '@/components/knowledge/recheck-card'
import { fileAddress, officeKindOf } from '@/components/rail/panels/office/address'
import { useRailState } from '@/components/rail/rail-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  answerKnowledgeGap,
  exportKnowledgePack,
  getKnowledgeSourceFile,
  importKnowledgePack,
  type KnowledgePackImportResult,
  listKnowledgeBoundaries,
  listKnowledgeCards,
  listKnowledgeGaps,
  listKnowledgeRechecks,
  listKnowledgeSources,
  resolveKnowledgeRecheck,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** `knowledge/报价单.xlsx` / `blob://k1` → 给人看的那个名字。 */
function nameOfSource(ref: string): string {
  const parts = ref.split(/[/\\]/)
  return parts[parts.length - 1] ?? ref
}

export function KnowledgePage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const rail = useRailState()
  const fileInput = useRef<HTMLInputElement>(null)
  const [imported, setImported] = useState<KnowledgePackImportResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

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
        <CardContent>
          {sources.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : uploads.length === 0 ? (
            <p className="text-sm text-ws-muted-fg" data-testid="knowledge-sources-empty">
              {t('knowledge.sources.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {uploads.map((source) => {
                const name = nameOfSource(source.ref)
                const previewable = officeKindOf(name) !== undefined
                return (
                  <li key={source.id}>
                    {/* 一份文件一张卡（WP96 的 `WsCard`）；整张卡可点 */}
                    <WsCard className="p-0">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-4 py-3 text-left"
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
                            : t('knowledge.sources.download_only')}
                        </WsTag>
                      </button>
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

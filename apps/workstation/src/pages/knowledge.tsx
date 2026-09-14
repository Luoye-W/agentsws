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
import { Download, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { GapRow } from '@/components/knowledge/gap-row'
import { RecheckCard } from '@/components/knowledge/recheck-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  answerKnowledgeGap,
  exportKnowledgePack,
  importKnowledgePack,
  type KnowledgePackImportResult,
  listKnowledgeBoundaries,
  listKnowledgeCards,
  listKnowledgeGaps,
  listKnowledgeRechecks,
  resolveKnowledgeRecheck,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function KnowledgePage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
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
  const doExport = async (): Promise<void> => {
    const blob = await exportKnowledgePack()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'knowledge-pack.zip'
    a.click()
    URL.revokeObjectURL(url)
  }

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

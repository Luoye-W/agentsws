/**
 * WP398（docs/106 §13 A8）：岗位页「词库」块——多少个词、几个差距词、最近一次更新；每个自家 ASIN 一行差距；
 * 「看词表」在第三栏开完整词表，「现在更新」读一次联想词（只有图标，字在 tooltip）。
 *
 * 还没有词库：同一个空块（WP395 的 {@link AmazonEmpty}）+ 「现在更新」。读不到联想词的原因照实写一行。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { AmazonEmpty, registerAmazonBlockBody } from '@/components/amazon/amazon-ops-board'
import { KeywordGapLineView } from '@/components/amazon/keyword-gap-line'
import { useRailState } from '@/components/rail/rail-state'
import { Button } from '@/components/ui/button'
import {
  type AmazonKeywordBankView,
  amazonKeywordsAddress,
  getAmazonKeywords,
  refreshAmazonKeywords,
} from '@/lib/amazon-keywords-api'
import { useApp } from '@/lib/app-context'

const when = (iso: string, lang: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 联想词这次没读成的那一句（读成了不出）。 */
function readerNote(v: AmazonKeywordBankView, fallback: string): string | undefined {
  const ac = v.last_refresh?.autocomplete
  if (ac !== undefined && ac.status !== 'ok' && ac.message !== undefined) return ac.message
  if (!v.reader_ready) return fallback
  return undefined
}

export function KeywordBankBlock({ assignment }: { assignment: string }): ReactNode {
  const { t, lang } = useApp()
  const rail = useRailState()
  const client = useQueryClient()
  const key = ['amazon-keywords', assignment]
  const view = useQuery({ queryKey: key, queryFn: () => getAmazonKeywords(assignment) })
  const refresh = useMutation({
    mutationFn: () => refreshAmazonKeywords({}, assignment),
    onSuccess: (r) => {
      client.setQueryData(key, r.view)
      void client.invalidateQueries({ queryKey: ['amazon-keywords-list'] })
    },
  })
  const refreshBtn = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={refresh.isPending ? t('amzkw.refreshing') : t('amzkw.refresh')}
      title={refresh.isPending ? t('amzkw.refreshing') : t('amzkw.refresh')}
      disabled={refresh.isPending}
      onClick={() => refresh.mutate()}
      data-testid="amzkw-refresh"
    >
      <RefreshCw className={refresh.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} />
    </Button>
  )
  const v = view.data
  if (v === undefined || v.updated_at === undefined)
    return (
      <div className="flex items-center gap-1" data-testid="amzkw-block">
        <AmazonEmpty text={t('amzops.keywords.empty')} testId="amzops-empty-keywords" />
        {view.isSuccess && refreshBtn}
      </div>
    )
  const note = readerNote(v, t('amzkw.reader_off'))
  const sortNote = lang === 'en' ? v.sort_note.en : v.sort_note.zh
  return (
    <div className="flex flex-col gap-2" data-testid="amzkw-block">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm" data-testid="amzkw-summary">
          {t('amzkw.summary', { total: v.total, gaps: v.gap_terms })}
        </span>
        <span className="text-xs text-ws-muted-fg" data-testid="amzkw-updated">
          {t('amzkw.updated', { at: when(v.updated_at, lang) })}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => rail.openAddress(amazonKeywordsAddress(assignment))}
            data-testid="amzkw-open"
          >
            {t('amzkw.open')}
          </Button>
          {refreshBtn}
        </span>
      </div>
      {note !== undefined && (
        <p className="text-xs text-ws-muted-fg" data-testid="amzkw-reader-note">
          {note}
        </p>
      )}
      {v.gaps.map((g) => (
        <KeywordGapLineView key={g.asin} gap={g} sortNote={sortNote} assignment={assignment} />
      ))}
    </div>
  )
}

/** 往 WP395 的面板里填「词库」块（`builtin-panels.tsx` 启动时调一次）。 */
export function registerKeywordBankBlock(): () => void {
  return registerAmazonBlockBody('keywords', KeywordBankBlock)
}

/**
 * "已经有人做过像的了"（40 §2.2 第 2 条、§5 E4）。
 *
 * 这是一张**选择题卡**，不是一句报错：三个选项——「复用它 / 合并进它 / 我这个不一样，仍新建」。
 * 选"仍新建"必须写一句为什么（少于 {@link MIN_DUPLICATE_REASON} 个字按钮就不给按），
 * 那句话会进工具箱，下次别人查到这条时看得到"他当初为什么另建"。
 *
 * 服务端已经先拦了一道（`409 similar_exists` / `400`）；这里的校验只是为了不让人白跑一趟。
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { MIN_DUPLICATE_REASON, type SimilarExistsDetails } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function SimilarChoiceCard({
  details,
  busy,
  error,
  onReuse,
  onMerge,
  onForceNew,
  onCancel,
}: {
  details: SimilarExistsDetails
  busy: boolean
  error?: string
  onReuse(entry_id: string): void
  onMerge(entry_id: string): void
  onForceNew(reason: string, similar_to: string[]): void
  onCancel(): void
}): React.ReactNode {
  const { t } = useApp()
  const [reason, setReason] = useState('')
  const [writing, setWriting] = useState(false)

  const candidates = details.candidates
  const first = candidates[0]
  const ids = candidates.map((c) => c.entry.id)
  const enough = reason.trim().length >= MIN_DUPLICATE_REASON

  return (
    <Card className="border-amber-400/60" data-testid="similar-choice">
      <CardHeader>
        <CardTitle className="text-sm">{t('similar.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {candidates.map((c) => (
          <div key={c.entry.id} className="flex flex-col rounded border px-2 py-1.5">
            <span className="text-sm font-medium">{c.entry.title}</span>
            <span className="text-xs text-muted-foreground">
              {t('toolbox.owner', { who: c.entry.owner })} ·{' '}
              {c.entry.used_by_positions.length === 0
                ? t('toolbox.positions.none')
                : t('toolbox.positions', { n: c.entry.used_by_positions.length })}
            </span>
            {c.reasons.length === 0 ? null : (
              <span className="text-xs text-muted-foreground">
                {t('similar.reasons', { reasons: c.reasons.join('；') })}
              </span>
            )}
          </div>
        ))}

        {error === undefined ? null : (
          <p className="text-xs text-destructive" data-testid="similar-error">
            {error}
          </p>
        )}

        {writing ? (
          <div className="flex flex-col gap-2">
            <label className="text-xs text-muted-foreground" htmlFor="similar-reason">
              {t('similar.reason.label')}
            </label>
            <Textarea
              id="similar-reason"
              rows={2}
              value={reason}
              placeholder={t('similar.reason.hint')}
              data-testid="similar-reason"
              onChange={(e) => {
                setReason(e.target.value)
              }}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy || !enough}
                data-testid="similar-confirm"
                onClick={() => {
                  onForceNew(reason.trim(), ids)
                }}
              >
                {t('similar.confirm')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setWriting(false)
                }}
              >
                {t('org.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || first === undefined}
              data-testid="similar-reuse"
              onClick={() => {
                if (first !== undefined) onReuse(first.entry.id)
              }}
            >
              {t('similar.reuse')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || first === undefined}
              data-testid="similar-merge"
              onClick={() => {
                if (first !== undefined) onMerge(first.entry.id)
              }}
            >
              {t('similar.merge')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid="similar-new"
              onClick={() => {
                setWriting(true)
              }}
            >
              {t('similar.new')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                onCancel()
              }}
            >
              {t('similar.cancel')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

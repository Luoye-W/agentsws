/**
 * 撞车选择题卡（40 §3.1）。
 *
 * 服务端在创建路径上回 `409`（`details.reason = similar_in_progress`）时，这张卡替
 * 「建不成」出面：先说清**谁在做、做到哪了**，再给三个出口——
 * 加入协作 / 交给他 / 我这个不一样。
 *
 * 三条纪律：
 * - 一次一张、一句人话，不给分数也不给相似度百分比（29 原则 ③：数字不给人猜）
 * - 「我这个不一样」必须写一句区别，不写按钮就是灰的（40 §3.1）
 * - 这张卡不自己发请求：怎么建由调用方决定（待办页与事项页两处都用它）
 */
import { Users } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SimilarCandidate } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 「仍新建」那句区别至少多少字（与服务端 `MIN_DISTINCT_REASON` 同一个数）。 */
export const MIN_DISTINCT_REASON = 8

export function CollisionCard({
  candidates,
  busy,
  onJoin,
  onHandoff,
  onForce,
  onCancel,
}: {
  candidates: SimilarCandidate[]
  busy: boolean
  onJoin(target: SimilarCandidate): void
  onHandoff(target: SimilarCandidate): void
  onForce(target: SimilarCandidate, reason: string): void
  onCancel(): void
}): React.ReactNode {
  const { t } = useApp()
  const [reason, setReason] = useState('')
  const target = candidates[0]
  if (target === undefined) return null
  const reasonOk = [...reason.trim()].length >= MIN_DISTINCT_REASON
  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-amber-400/60 bg-amber-50/50 p-3 dark:bg-amber-950/20"
      data-testid="collision-card"
      data-candidate={target.id}
      aria-live="polite"
    >
      <p className="flex items-start gap-1.5 text-sm font-medium">
        <Users className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          {t('collision.headline', {
            who: target.owner_label ?? target.owner,
            title: target.title,
          })}
          {target.cards > 0 ? t('collision.cards', { count: target.cards }) : null}
        </span>
      </p>
      {candidates.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          {t('collision.more', { count: candidates.length - 1 })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            onJoin(target)
          }}
        >
          {t('collision.join')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            onHandoff(target)
          }}
        >
          {t('collision.handoff')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t('collision.cancel')}
        </Button>
      </div>
      <div className="flex gap-2">
        <Input
          value={reason}
          aria-label={t('collision.distinct')}
          placeholder={t('collision.distinct.placeholder')}
          data-testid="collision-reason"
          onChange={(e) => {
            setReason(e.target.value)
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !reasonOk}
          data-testid="collision-force"
          onClick={() => {
            onForce(target, reason.trim())
          }}
        >
          {t('collision.force')}
        </Button>
      </div>
    </section>
  )
}

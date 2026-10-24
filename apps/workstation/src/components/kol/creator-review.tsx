/**
 * 移植自 KOLAgents `src/components/influencer/creator-tags-panel.tsx` 与 `creator-info-card.tsx` 的
 * 「审核决定」一节、`VettingBadge` @ 88d74b2c（Luoye 的产品，非模板代码）。
 *
 * WP502（决策 1763 B）：人工标签与审核决定——人自己的判断，按下就算（不出卡），只记在本机。
 *
 * 照搬的纪律：
 * - 标签就是「一排标签 + 一个输入框」：没有颜色、没有标签管理页、没有自动补全（KOLAgents：在谁都还没有
 *   五十个标签之前，每加一个控件都是对着想象中的问题设计的）；
 * - **不做乐观更新**：标签出现了又因为没写成而消失，比转 200ms 的圈更糟——人会以为已经存上了；
 * - 审核三个动作：通过 / 淘汰…（展开一个理由框）/ 重置为待审（定过了才出）。
 *
 * 改的地方：淘汰的理由**可不填**（Luoye 1763 B「带一句理由可选」；KOLAgents 是必填）；样式换成工坊的令牌与共用件。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { StatusPill } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  type KolCreatorDetailData,
  type KolCreatorReviewData,
  reviewKolCreator,
  setKolCreatorTags,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { dayOf } from './creator-display'
import { errorText, KolError } from './kol-shared'

/** 一个标签最长几个字（同服务端 `KOL_TAG_MAX_LENGTH`、KOLAgents 输入框的 40）。 */
const TAG_MAX = 40

/** 审核状态小标（KOLAgents `VettingBadge`：通过 = 主色、淘汰 = 红、待审 = 描边）。 */
export function ReviewBadge({
  review,
  showPending = false,
}: {
  review: KolCreatorReviewData | undefined
  /** 待审要不要也画（详情头部画，候选池卡片不画——只把定过的那几个标出来）。 */
  showPending?: boolean
}): ReactNode {
  const { t } = useApp()
  if (review?.decision === 'approved')
    return (
      <StatusPill tone="good" data-testid="kol-review-badge" data-decision="approved">
        {t('kol.review.approved')}
      </StatusPill>
    )
  if (review?.decision === 'rejected')
    return (
      <StatusPill tone="bad" data-testid="kol-review-badge" data-decision="rejected">
        {t('kol.review.rejected')}
      </StatusPill>
    )
  if (!showPending) return null
  return (
    <StatusPill tone="neutral" data-testid="kol-review-badge" data-decision="pending">
      {t('kol.review.pending')}
    </StatusPill>
  )
}

/** 刷新详情与候选池（两处都显示标签与审核）。 */
function useRefresh(creatorId: string): () => void {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ queryKey: ['kol-creator', creatorId] })
    void client.invalidateQueries({ queryKey: ['kol-creators'] })
  }
}

/** 标签那一排（KOLAgents `CreatorTagsPanel`）。 */
export function CreatorTagsPanel({
  assignment,
  creatorId,
  tags,
}: {
  assignment: string
  creatorId: string
  tags: readonly string[]
}): ReactNode {
  const { t } = useApp()
  const refresh = useRefresh(creatorId)
  const [pending, setPending] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const save = useMutation({
    mutationFn: (next: string[]) => setKolCreatorTags(creatorId, next, assignment),
    onSuccess: () => {
      setError(undefined)
      setPending('')
      refresh()
    },
    onError: (e: unknown) => {
      setError(errorText(e, t('kol.tags.failed')))
    },
  })
  const add = (): void => {
    const label = pending.trim()
    if (label === '' || save.isPending) return
    if (tags.some((x) => x.toLowerCase() === label.toLowerCase())) {
      setPending('')
      return
    }
    save.mutate([...tags, label])
  }
  return (
    <div className="flex flex-col gap-2" data-testid="kol-tags">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t('kol.tags.empty')}</span>
        ) : null}
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2 text-xs"
            data-testid="kol-tag"
          >
            <span className="truncate">{tag}</span>
            <button
              type="button"
              className="rounded-full p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground disabled:opacity-50"
              aria-label={t('kol.tags.remove', { label: tag })}
              title={t('kol.tags.remove', { label: tag })}
              disabled={save.isPending}
              data-testid="kol-tag-remove"
              onClick={() => {
                save.mutate(tags.filter((x) => x !== tag))
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={pending}
          maxLength={TAG_MAX}
          placeholder={t('kol.tags.placeholder')}
          className="h-8 max-w-56"
          data-testid="kol-tag-input"
          onChange={(e) => {
            setPending(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            add()
          }}
        />
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={t('kol.tags.add')}
          title={t('kol.tags.add')}
          disabled={save.isPending || pending.trim() === ''}
          data-testid="kol-tag-add"
          onClick={add}
        >
          <Plus className="size-4" aria-hidden />
        </Button>
      </div>
      <KolError error={error} testid="kol-tags-error" />
    </div>
  )
}

/** 审核决定那一节（KOLAgents「Human vetting」）。 */
export function ReviewSection({
  assignment,
  view,
}: {
  assignment: string
  view: Pick<KolCreatorDetailData, 'creator' | 'review'>
}): ReactNode {
  const { t } = useApp()
  const creatorId = view.creator.id
  const refresh = useRefresh(creatorId)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const decided = view.review?.decision
  const vet = useMutation({
    mutationFn: (input: { decision: 'approved' | 'rejected' | 'pending'; reason?: string }) =>
      reviewKolCreator(creatorId, input, assignment),
    onSuccess: () => {
      setError(undefined)
      setRejecting(false)
      setReason('')
      refresh()
    },
    onError: (e: unknown) => {
      setError(errorText(e, t('kol.review.failed')))
    },
  })
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-ws-line p-3"
      data-testid="kol-review"
      data-decision={decided ?? 'pending'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium" data-slot="title">
          {t('kol.review.title')}
        </h4>
        <ReviewBadge review={view.review} showPending />
        {view.review === undefined ? null : (
          <span className="text-xs text-muted-foreground" data-slot="status">
            {dayOf(view.review.decided_at)}
          </span>
        )}
      </div>
      {view.review?.reason === undefined ? null : (
        <p className="text-xs text-muted-foreground" data-testid="kol-review-reason">
          {t('kol.review.reason', { reason: view.review.reason })}
        </p>
      )}
      {rejecting ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={reason}
            maxLength={300}
            placeholder={t('kol.review.reject.placeholder')}
            data-testid="kol-review-reason-input"
            onChange={(e) => {
              setReason(e.target.value)
            }}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={vet.isPending}
              data-testid="kol-review-reject-confirm"
              onClick={() => {
                const r = reason.trim()
                vet.mutate({ decision: 'rejected', ...(r === '' ? {} : { reason: r }) })
              }}
            >
              {t('kol.review.reject.confirm')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRejecting(false)
              }}
            >
              {t('kol.review.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={vet.isPending || decided === 'approved'}
            data-testid="kol-review-approve"
            onClick={() => {
              vet.mutate({ decision: 'approved' })
            }}
          >
            {t('kol.review.approve')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={vet.isPending || decided === 'rejected'}
            data-testid="kol-review-reject"
            onClick={() => {
              setRejecting(true)
            }}
          >
            {t('kol.review.reject')}
          </Button>
          {decided === undefined ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={vet.isPending}
              data-testid="kol-review-reset"
              onClick={() => {
                vet.mutate({ decision: 'pending' })
              }}
            >
              {t('kol.review.reset')}
            </Button>
          )}
        </div>
      )}
      <KolError error={error} testid="kol-review-error" />
    </section>
  )
}

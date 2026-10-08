/**
 * WP268（决策 213）：事项里的**挑图卡**与**生图超额卡**。
 *
 * 挑图卡：几张图并排（素材库原图，带登录令牌取），每张下面一颗「用这张」；底下「再来一版（约 X 积分）」与「都不要」。
 * 带 `upload` 的（网页模板要挂到网站）多一行：选中后传到店铺「文件」、挂到网站（未发布预览）。
 * 超额卡：一句「再出 N 张，约 X 积分，要继续吗？」+ 继续出 / 不出了。
 * 批过的缩成一行（同别的内嵌卡）。
 */
import type { ImageBudgetPayload, ImagePickPayload } from '@agentsws/contracts'
import type { DeckAction, DeckCard } from '@agentsws/deck'
import { Check, CircleCheck, CircleX, Images, RefreshCw, Store } from 'lucide-react'
import type { ReactNode } from 'react'
import { AuthedImage } from '@/components/images/authed-image'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import { AiShell, cardWaiting, clockOf } from './matter-timeline'

type Decide = (
  card: DeckCard,
  action: Exclude<DeckAction, 'open'>,
  option?: string,
  reason?: string,
) => void

const isPick = (p: unknown): p is ImagePickPayload =>
  typeof p === 'object' && p !== null && (p as { form?: unknown }).form === 'image_pick'
const isBudget = (p: unknown): p is ImageBudgetPayload =>
  typeof p === 'object' && p !== null && (p as { form?: unknown }).form === 'image_budget'

export const isImageCard = (card: DeckCard | undefined): boolean =>
  card !== undefined && (card.kind === 'image_pick' || card.kind === 'image_budget')

export function ImageCard({
  at,
  eventId,
  card,
  roleId,
  roleName,
  deciding,
  onDecide,
}: {
  at: string
  eventId: string
  card: DeckCard
  roleId?: string | undefined
  roleName: string
  deciding: boolean
  onDecide: Decide
}): ReactNode {
  const { t, lang } = useApp()
  const payload = card.detail.payload
  if (!cardWaiting(card)) {
    const good =
      card.status !== 'rejected' && card.status !== 'withdrawn' && card.status !== 'expired'
    return (
      <AiShell id={eventId} roleId={roleId} name={roleName} at={at}>
        <div
          className="flex max-w-[560px] items-center gap-2 rounded-2xl border border-ws-line bg-ws-surface px-3.5 py-2.5 opacity-90"
          data-testid="matter-card-done"
          data-status={card.status}
        >
          {good ? (
            <CircleCheck aria-hidden className="size-3.5 text-ws-good" />
          ) : (
            <CircleX aria-hidden className="size-3.5 text-ws-muted-fg" />
          )}
          <span className="min-w-0 truncate text-[13px] font-medium text-ws-body">
            {card.title}
          </span>
          <span className="ml-auto shrink-0 text-[12px] text-ws-muted-fg">{clockOf(at, lang)}</span>
        </div>
      </AiShell>
    )
  }

  if (isBudget(payload))
    return (
      <AiShell id={eventId} roleId={roleId} name={roleName} at={at}>
        <div
          className="max-w-[560px] overflow-hidden rounded-2xl border-[1.5px] border-ws-warn/55 bg-ws-card shadow-ws"
          data-testid="image-budget-card"
          data-card={card.id}
        >
          <div className="px-3.5 pt-3 pb-1 text-[15px] leading-[1.35] font-semibold text-ws-ink">
            {card.title}
          </div>
          <p className="px-3.5 pb-3 text-[13px] text-ws-body">{card.summary}</p>
          <div className="flex items-center gap-2 border-t border-ws-line bg-ws-surface px-3.5 py-2.5">
            <Button
              size="sm"
              disabled={deciding}
              data-testid="image-budget-go"
              onClick={() => {
                onDecide(card, 'approve')
              }}
            >
              {t('images.budget.go')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={deciding}
              onClick={() => {
                onDecide(card, 'reject', undefined, t('images.budget.no'))
              }}
            >
              {t('images.budget.no')}
            </Button>
          </div>
        </div>
      </AiShell>
    )

  const pick = isPick(payload) ? payload : undefined
  const variants = pick?.variants ?? []
  const cols =
    variants.length === 1 ? 'grid-cols-1' : variants.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
  return (
    <AiShell id={eventId} roleId={roleId} name={roleName} at={at}>
      <div
        className="max-w-[560px] overflow-hidden rounded-2xl border-[1.5px] border-ws-warn/55 bg-ws-card shadow-ws"
        data-testid="image-pick-card"
        data-card={card.id}
      >
        <div className="flex items-center gap-2 px-3.5 pt-3 text-[12.5px] text-ws-muted-fg">
          <Images aria-hidden className="size-3.5" />
          {t('images.pick.head')}
          <span className="ml-auto text-[12px]">
            {pick === undefined
              ? null
              : pick.own_key === true
                ? t('images.pick.own_key')
                : t('images.pick.credits', { credits: pick.credits })}
          </span>
        </div>
        <p className="px-3.5 pt-2 text-[15px] leading-[1.35] font-semibold break-words text-ws-ink">
          {card.title}
        </p>
        {pick?.upload === true ? (
          <p className="flex items-center gap-1.5 px-3.5 pt-1 text-[12.5px] text-ws-muted-fg">
            <Store aria-hidden className="size-3.5" />
            {t('images.pick.upload')}
          </p>
        ) : null}
        <div className={`grid ${cols} gap-2 px-3.5 pt-3 pb-3`} data-testid="image-pick-grid">
          {variants.map((v) => (
            <figure key={v.id} className="flex flex-col gap-1.5" data-testid="image-pick-variant">
              <div
                className="relative overflow-hidden rounded-[10px] bg-ws-tint ring-1 ring-ws-line"
                style={{
                  aspectRatio:
                    v.width !== undefined && v.height !== undefined
                      ? `${v.width} / ${v.height}`
                      : '1 / 1',
                }}
              >
                <AuthedImage src={v.url} alt={v.label} className="size-full" />
                <span className="absolute top-1.5 left-1.5 rounded-full bg-black/60 px-1.5 text-[11px] text-white">
                  {v.label}
                </span>
              </div>
              <Button
                size="xs"
                variant="outline"
                className="gap-1"
                disabled={deciding}
                data-testid="image-pick-use"
                onClick={() => {
                  onDecide(card, 'approve', v.id)
                }}
              >
                <Check aria-hidden className="size-3" />
                {t('images.pick.use')}
              </Button>
            </figure>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-ws-line bg-ws-surface px-3.5 py-2.5">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={deciding}
            data-testid="image-pick-again"
            onClick={() => {
              onDecide(card, 'approve', 'again')
            }}
          >
            <RefreshCw aria-hidden className="size-3.5" />
            {pick === undefined || pick.own_key === true || pick.again_credits === 0
              ? t('images.pick.again')
              : t('images.pick.again.cost', { credits: pick.again_credits })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={deciding}
            data-testid="image-pick-none"
            onClick={() => {
              onDecide(card, 'reject', undefined, t('images.pick.none.reason'))
            }}
          >
            {t('images.pick.none')}
          </Button>
        </div>
      </div>
    </AiShell>
  )
}

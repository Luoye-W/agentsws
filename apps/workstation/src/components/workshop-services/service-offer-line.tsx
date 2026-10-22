/**
 * WP390（docs/105 §4 / §5）：**推荐卡**——挂在 AI 那段话末尾的一行「名字 · 起价 · 看看」。
 *
 * 不是审批卡、不进卡片队列（36 §2：只有要人拍板的才是卡）。卡上只写做什么、多少——不写风险、不写合作方名字
 * （只有「工坊团队 / 工坊合作的专业团队」两种说法，进问号）。「看看」：标准件出价目单、定制件让 AI 在这件事里问清需求；
 * 「不用」：这一项在这个品牌 30 天不再主动推（服务端记进记忆）。
 */
import type { ServiceOffer } from '@agentsws/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Handshake, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import {
  creditsText,
  declineWorkshopService,
  startWorkshopService,
} from '@/lib/workshop-services-api'

export function ServiceOfferLine({
  offer,
  matterId,
}: {
  offer: ServiceOffer
  matterId?: string | undefined
}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const [state, setState] = useState<'idle' | 'started' | 'declined'>('idle')
  const name = lang === 'zh' ? offer.label_zh : offer.label_en
  const price =
    offer.from_credits === undefined
      ? undefined
      : offer.pricing_mode === 'fixed'
        ? t('svc.offer.price', { credits: creditsText(offer.from_credits, lang) })
        : t('svc.offer.from', { credits: creditsText(offer.from_credits, lang) })
  const look = useMutation({
    mutationFn: () =>
      startWorkshopService({
        service_id: offer.service_id,
        ...(matterId === undefined ? {} : { matter_id: matterId }),
      }),
    onSuccess: () => {
      setState('started')
      void client.invalidateQueries({ queryKey: ['matter'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
    },
  })
  const no = useMutation({
    mutationFn: () => declineWorkshopService(offer.service_id),
    onSuccess: () => setState('declined'),
  })
  if (state === 'declined')
    return (
      <p className="mt-2 text-[13px] text-ws-muted-fg" data-testid="service-offer-declined">
        {t('svc.offer.declined')}
      </p>
    )
  return (
    <div
      className="mt-2.5 flex max-w-[520px] items-center gap-2 rounded-full bg-ws-surface py-1 pr-1 pl-3 text-[13px] shadow-[inset_0_0_0_1px_var(--ws-line)]"
      data-testid="service-offer"
      data-service={offer.service_id}
    >
      <Handshake aria-hidden className="size-3.5 shrink-0 text-ws-brand" />
      <span className="min-w-0 truncate font-medium text-ws-ink">{name}</span>
      {price === undefined ? null : <span className="shrink-0 text-ws-muted-fg">· {price}</span>}
      {offer.pricing_mode === 'quote' ? (
        <span className="hidden shrink-0 text-ws-muted-fg sm:inline">· {t('svc.offer.quote')}</span>
      ) : null}
      <Hint text={`${t(`svc.provider.${offer.provider_label}`)} · ${t('svc.offer.tip')}`} />
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {state === 'started' ? (
          <span className="px-2 text-[12px] text-ws-muted-fg">{t('svc.offer.started')}</span>
        ) : (
          <Button
            size="xs"
            className="rounded-full"
            data-testid="service-offer-look"
            disabled={look.isPending}
            onClick={() => look.mutate()}
          >
            {t('svc.offer.look')}
          </Button>
        )}
        {state === 'started' ? null : (
          <button
            type="button"
            aria-label={t('svc.offer.decline')}
            title={t('svc.offer.decline')}
            data-testid="service-offer-decline"
            disabled={no.isPending}
            onClick={() => no.mutate()}
            className="inline-flex size-6 items-center justify-center rounded-full text-ws-muted-fg hover:bg-ws-card hover:text-ws-ink"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * WP390（docs/105 §4.1 ②）：「缺设置」卡（连接卡 / 配置卡）上的可选项「交给工坊办」——服务目录里声明了这个卡点的
 * 那一项。点了出价目单（或让 AI 问清需求）；办成后回到这一步接着做（决策 690）。自己连 / 自己填照旧在卡上。
 */
import type { ServiceOffer } from '@agentsws/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Handshake } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { creditsText, startWorkshopService } from '@/lib/workshop-services-api'

export function WorkshopHandoff({
  offer,
  cardId,
  matterId,
}: {
  offer: ServiceOffer
  cardId: string
  matterId?: string | undefined
}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const go = useMutation({
    mutationFn: () =>
      startWorkshopService({
        service_id: offer.service_id,
        from_card: cardId,
        ...(matterId === undefined ? {} : { matter_id: matterId }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['matter'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
    },
  })
  const name = lang === 'zh' ? offer.label_zh : offer.label_en
  const price =
    offer.from_credits === undefined
      ? ''
      : offer.pricing_mode === 'fixed'
        ? t('svc.offer.price', { credits: creditsText(offer.from_credits, lang) })
        : t('svc.offer.from', { credits: creditsText(offer.from_credits, lang) })
  return (
    <div
      className="mt-2 flex items-center gap-1.5 text-[13px]"
      data-testid="setup-workshop-handoff"
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 text-ws-brand hover:underline disabled:opacity-60"
        disabled={go.isPending || go.isSuccess}
        onClick={() => go.mutate()}
      >
        <Handshake aria-hidden className="size-3.5" />
        {go.isSuccess ? t('svc.offer.started') : t('svc.handoff')}
      </button>
      <Hint text={t('svc.handoff.tip', { name, price })} />
    </div>
  )
}

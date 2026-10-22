/**
 * WP390（docs/105 §4.1 ③）：**想逛的时候找得到**——
 * - 账号菜单「工坊服务」→ 第三栏这一页：我的订单 + 全部服务（按岗位分组）；
 * - 岗位页右栏底部那张卡：这个岗位能用的服务（最多三项）+ 几单在做。
 *
 * 服务目录是云上那一份的本机缓存；后台加一行，这里不改代码就有。卡上不写风险、不写合作方名字。
 */
import {
  type ServiceView,
  serviceStartCredits,
  servicesForPosition,
  type WorkshopServiceOrderRow,
} from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Handshake } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRailState } from '@/components/rail/rail-state'
import {
  type RailCardBodyProps,
  type RailPanelBodyProps,
  useCardTotal,
} from '@/components/rail/registry'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { getPositions } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  creditsText,
  isOpenOrder,
  listWorkshopServices,
  serviceOrderAddress,
  startWorkshopService,
  WORKSHOP_SERVICES_KEY,
  waitsForYou,
} from '@/lib/workshop-services-api'
import { useWorkshopOrders } from './status'

const ROW =
  'flex w-full min-w-0 items-center gap-2 rounded-[8px] px-1.5 py-1 text-left text-[13px] text-ws-body hover:bg-sidebar-accent/60'

export const useWorkshopServices = () =>
  useQuery({
    queryKey: WORKSHOP_SERVICES_KEY,
    queryFn: () => listWorkshopServices(),
    retry: false,
    staleTime: 5 * 60_000,
  })

/** 「起价 X 积分」/「X 积分」。 */
function usePriceText(): (s: ServiceView) => string | undefined {
  const { t, lang } = useApp()
  return (s) => {
    const from = serviceStartCredits(s)
    if (from === undefined) return undefined
    return s.pricing_mode === 'fixed'
      ? t('svc.offer.price', { credits: creditsText(from, lang) })
      : t('svc.offer.from', { credits: creditsText(from, lang) })
  }
}

/** 一项服务一行：名字 · 起价 ·（问号：谁来做）· 看看。 */
function ServiceRow({ s, position_id }: { s: ServiceView; position_id?: string }): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const price = usePriceText()(s)
  const start = useMutation({
    mutationFn: () =>
      startWorkshopService({
        service_id: s.id,
        ...(position_id === undefined ? {} : { position_id }),
      }),
    onSuccess: (r) => {
      void client.invalidateQueries({ queryKey: ['deck'] })
      if (r.matter_id !== undefined) void navigate(`/matters/${encodeURIComponent(r.matter_id)}`)
      else if (r.card_id !== undefined) void navigate(`/cards/${encodeURIComponent(r.card_id)}`)
    },
  })
  return (
    <li
      className="flex min-w-0 items-center gap-2 px-1.5 py-1 text-[13px]"
      data-testid="service-row"
      data-id={s.id}
    >
      <span className="min-w-0 truncate font-medium text-ws-ink">
        {lang === 'zh' ? s.label_zh : s.label_en}
      </span>
      {price === undefined ? null : (
        <span className="shrink-0 text-[12px] text-ws-muted-fg">{price}</span>
      )}
      <Hint
        text={`${lang === 'zh' ? s.summary_zh : s.summary_en}（${t(`svc.provider.${s.provider_label}`)}）`}
      />
      <Button
        size="xs"
        variant="outline"
        className="ml-auto shrink-0"
        data-testid="service-row-look"
        disabled={start.isPending}
        onClick={() => start.mutate()}
      >
        {t('svc.offer.look')}
      </Button>
    </li>
  )
}

function OrderRow({ row }: { row: WorkshopServiceOrderRow }): ReactNode {
  const { t, lang } = useApp()
  const rail = useRailState()
  const o = row.order
  return (
    <li>
      <button
        type="button"
        className={ROW}
        data-testid="service-order-row"
        data-id={o.id}
        onClick={() => {
          rail.openAddress(serviceOrderAddress(o.id))
        }}
      >
        {waitsForYou(o.status) || row.card_id !== undefined ? (
          <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-ws-warn" />
        ) : null}
        <span className="min-w-0 truncate">{lang === 'zh' ? o.label_zh : o.label_en}</span>
        <span className="ml-auto shrink-0 text-xs text-ws-muted-fg">
          {t(`svc.status.${o.status}`)}
        </span>
      </button>
    </li>
  )
}

/** 没关联 / 要重新登录 / 取不到：一句话 + 一个钮（不画一堆空表）。 */
function CatalogNotice({
  linked,
  reauth,
  notice,
}: {
  linked: boolean
  reauth?: boolean
  notice?: string
}): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  if (linked && reauth !== true && notice === undefined) return null
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-ws-surface px-2.5 py-2 text-[12.5px]"
      data-testid="services-notice"
    >
      <span className="min-w-0 flex-1 text-ws-body">
        {!linked ? t('svc.not_linked') : reauth === true ? t('svc.reauth') : notice}
      </span>
      {!linked || reauth === true ? (
        <Button size="xs" onClick={() => void navigate('/settings?tab=account')}>
          {!linked ? t('svc.not_linked.go') : t('svc.reauth.go')}
        </Button>
      ) : null}
    </div>
  )
}

/** 账号菜单「工坊服务」那一页：我的订单 + 全部服务（按岗位分组）。 */
export function WorkshopServicesPanel(_props: RailPanelBodyProps): ReactNode {
  const { t, lang } = useApp()
  const catalog = useWorkshopServices()
  const orders = useWorkshopOrders('all')
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions, retry: false })
  const nameOf = (id: string): string => {
    const p = positions.data?.instances?.find((x) => x.position_id === id)
    return p === undefined ? id : lang === 'zh' ? p.name.zh : p.name.en
  }
  const services = (catalog.data?.services ?? []).filter((s) => s.available)
  const groups = new Map<string, ServiceView[]>()
  for (const s of services) {
    const key = s.positions[0] ?? ''
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const rows = orders.data?.orders ?? []
  return (
    <div className="flex flex-col gap-4 p-3" data-testid="workshop-services-panel">
      {catalog.data === undefined ? null : (
        <CatalogNotice
          linked={catalog.data.linked}
          {...(catalog.data.reauth === true ? { reauth: true } : {})}
          {...(catalog.data.notice === undefined ? {} : { notice: catalog.data.notice })}
        />
      )}
      <section>
        <h4 className="mb-1 px-1.5 text-[12px] font-medium text-ws-muted-fg">
          {t('svc.list.mine')}
        </h4>
        {rows.length === 0 ? (
          <p className="px-1.5 text-[12px] text-ws-muted-fg">{t('svc.list.none')}</p>
        ) : (
          <ul className="flex flex-col gap-px">
            {[
              ...rows.filter((r) => isOpenOrder(r.order.status)),
              ...rows.filter((r) => !isOpenOrder(r.order.status)),
            ].map((r) => (
              <OrderRow key={r.order.id} row={r} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="mb-1 px-1.5 text-[12px] font-medium text-ws-muted-fg">
          {t('svc.list.all')}
        </h4>
        {services.length === 0 ? (
          <p className="px-1.5 text-[12px] text-ws-muted-fg">{t('svc.list.empty')}</p>
        ) : (
          [...groups.entries()].map(([pos, list]) => (
            <div key={pos} className="mb-2" data-testid="services-group" data-position={pos}>
              <p className="px-1.5 text-xs text-ws-muted-fg">
                {pos === '' ? t('svc.list.other') : nameOf(pos)}
              </p>
              <ul className="flex flex-col">
                {list.map((s) => (
                  <ServiceRow key={s.id} s={s} {...(pos === '' ? {} : { position_id: pos })} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  )
}

/** 右栏那张卡：岗位页 = 这个岗位能用的服务（最多三项）+ 在做的单；别处 = 在做的单。 */
export function WorkshopServicesCard({ scope, limit, onTotal }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const catalog = useWorkshopServices()
  const orders = useWorkshopOrders('open')
  const position = scope?.tier === 'position' ? scope.scope_id : undefined
  const here =
    position === undefined ? [] : servicesForPosition(catalog.data?.services ?? [], position)
  const rows = (orders.data?.orders ?? []).filter(
    (r) => position === undefined || r.position_id === undefined || r.position_id === position,
  )
  // WP433：卡上只截在做的单（能用的服务全列），「显示更多」按单数算
  useCardTotal(onTotal, rows.length)
  if (catalog.data !== undefined && (!catalog.data.linked || catalog.data.reauth === true))
    return (
      <CatalogNotice
        linked={catalog.data.linked}
        {...(catalog.data.reauth === true ? { reauth: true } : {})}
      />
    )
  if (here.length === 0 && rows.length === 0)
    return (
      <p className="px-1.5 text-[12px] text-ws-muted-fg" data-testid="card-empty">
        {t('svc.list.none')}
      </p>
    )
  return (
    <div className="flex flex-col gap-2" data-testid="workshop-services-card">
      {rows.length === 0 ? null : (
        <ul className="flex flex-col gap-px">
          {rows.slice(0, limit).map((r) => (
            <OrderRow key={r.order.id} row={r} />
          ))}
        </ul>
      )}
      {here.length === 0 ? null : (
        <div>
          <p className="flex items-center gap-1 px-1.5 text-xs text-ws-muted-fg">
            <Handshake aria-hidden className="size-3" />
            {t('svc.list.position')}
          </p>
          <ul className="flex flex-col">
            {here.map((s) => (
              <ServiceRow
                key={s.id}
                s={s}
                {...(position === undefined ? {} : { position_id: position })}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

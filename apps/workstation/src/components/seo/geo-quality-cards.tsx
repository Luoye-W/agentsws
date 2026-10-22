/**
 * WP380：两种新的 `geo_watch` 卡面（「改东西」家族，卡底照旧「就这样 / 不要」）。
 *
 * - 对外说法分派卡（`geo_consistency`）：按岗位分组（建站 / 网站运营 / 公关），每处一行「写的 → 官方」，
 *   可以勾掉不派的那几处，再「改好了，就这样」（带着改过的分组批）；批了每个岗位各开一件事。
 * - 复查卡（`geo_recheck`）：看的数前 → 后（带 n）+ 建议（保留 / 扩大 / 修改 / 停）+ 一句为什么。
 */
import type { GeoWatchCardPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { type ReactNode, useState } from 'react'
import { WsTag } from '@/components/design'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import { pct } from './geo-bits'
import { useApprove } from './geo-watch-card-body'

type ConsistencyPayload = Extract<GeoWatchCardPayload, { form: 'geo_consistency' }>
type RecheckPayload = Extract<GeoWatchCardPayload, { form: 'geo_recheck' }>

export function ConsistencyCardBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: ConsistencyPayload
}): ReactNode {
  const { t } = useApp()
  const approve = useApprove(card)
  const all = payload.groups.flatMap((g) => g.findings.map((f) => f.id))
  const [keep, setKeep] = useState<string[]>(all)
  const decidable = card.available_actions.includes('approve')
  const changed = keep.length !== all.length
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-geo-consistency">
      {payload.groups.map((g) => (
        <div key={g.owner} className="flex flex-col gap-1" data-testid="deck-geo-consistency-group">
          <span className="text-xs font-medium text-ws-muted-fg">{t(`geo.owner.${g.owner}`)}</span>
          <ul className="flex flex-col gap-1 text-[13px]">
            {g.findings.map((f) => (
              <li key={f.id}>
                <label className="flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={keep.includes(f.id)}
                    disabled={!decidable}
                    onChange={(e) =>
                      setKeep(e.target.checked ? [...keep, f.id] : keep.filter((x) => x !== f.id))
                    }
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5">
                      <WsTag className="h-[18px] px-1.5 text-xs">{t(`geo.field.${f.field}`)}</WsTag>
                      {f.verdict === 'outdated' ? (
                        <span className="text-xs text-ws-warn">{t('geo.card.cons.outdated')}</span>
                      ) : null}
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="truncate text-xs text-ws-muted-fg underline-offset-2 hover:underline"
                      >
                        {f.url.replace(/^https?:\/\//, '')}
                      </a>
                    </span>
                    <span>{t('geo.card.cons.said', { s: f.said, o: f.official })}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <span className="text-xs text-ws-muted-fg">
        {t('geo.card.cons.recheck', { d: payload.recheck_on.slice(5) })}
      </span>
      {decidable && changed && keep.length > 0 ? (
        <Button
          size="sm"
          className="w-fit"
          disabled={approve.isPending}
          data-testid="deck-geo-consistency-save"
          onClick={() =>
            approve.mutate({
              ...payload,
              groups: payload.groups
                .map((g) => ({ ...g, findings: g.findings.filter((f) => keep.includes(f.id)) }))
                .filter((g) => g.findings.length > 0),
            })
          }
        >
          {t('geo.card.edit.done')}
        </Button>
      ) : null}
    </div>
  )
}

export function RecheckCardBody({ payload }: { payload: RecheckPayload }): ReactNode {
  const { t } = useApp()
  const r = payload.recheck
  return (
    <div className="mt-2.5 flex flex-col gap-1.5 text-[13px]" data-testid="deck-geo-recheck">
      <span className="flex items-center gap-2">
        {r.advice === undefined ? null : (
          <WsTag
            className={`h-[18px] px-1.5 text-xs ${r.advice === 'stop' ? 'bg-ws-bad-bg text-ws-bad' : r.advice === 'expand' ? 'bg-ws-good-bg text-ws-good' : ''}`}
            data-testid="deck-geo-recheck-advice"
          >
            {t(`geo.advice.${r.advice}`)}
          </WsTag>
        )}
        <span className="ws-num">
          {t('geo.card.recheck.change', {
            m: t(`geo.metric.${r.metric}`),
            a: `${pct(r.before.value)}（n=${r.before.n}）`,
            b: `${pct(r.after?.value)}（n=${r.after?.n ?? 0}）`,
          })}
        </span>
      </span>
      {r.why === undefined ? null : <span className="text-ws-muted-fg">{r.why}</span>}
    </div>
  )
}

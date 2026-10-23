/**
 * WP335（docs/99 §5.4，WP321 给 O3 的接口）：`geo_watch` 卡（「改东西」家族：就这样 / 不要 / 稍后）的卡面。
 *
 * - 设定卡（`geo_watch_setup`）：一眼几行——追几条（带品牌名几条）、关注的 AI、竞品、每月约多少积分
 *   （Claude 那一份单写）；点「改」就地改：追几条、勾哪几条问题、关注哪几家 AI、去掉竞品；
 *   「改好了，就这样」= 带着改过的策略批（`approve` + `edited_payload`，服务端落成关注设置）。
 * - 竞品卡（`geo_watch_competitors`）：回答里反复出现的品牌，勾掉不要的再批。
 * - WP380：对外说法分派卡（`geo_consistency`）、复查卡（`geo_recheck`），卡面在 `geo-quality-cards.tsx`。
 *
 * 卡底那排「就这样」照旧是不改直接批。
 */
import type {
  AiPlatform,
  BrandWatchCompetitor,
  GeoQuestion,
  GeoStrategyTopicShare,
  GeoWatchCardPayload,
  GeoWatchStrategy,
} from '@agentsws/contracts'
import { BRAND_WATCH_DEFAULT_PLATFORMS, GEO_PROMPT_TIERS } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { ConsistencyCardBody, RecheckCardBody } from './geo-quality-cards'

type SetupPayload = Extract<GeoWatchCardPayload, { form: 'geo_watch_setup' }>
type RivalsPayload = Extract<GeoWatchCardPayload, { form: 'geo_watch_competitors' }>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 这张卡是不是 `geo_watch` 的两种卡面之一。 */
export function isGeoWatchPayload(p: unknown): p is GeoWatchCardPayload {
  return (
    isRecord(p) &&
    ((p.form === 'geo_watch_setup' && isRecord(p.strategy) && isRecord(p.estimate)) ||
      (p.form === 'geo_watch_competitors' && Array.isArray(p.competitors)) ||
      // WP380：对外说法分派卡、复查卡
      (p.form === 'geo_consistency' && Array.isArray(p.groups)) ||
      (p.form === 'geo_recheck' && isRecord(p.recheck)))
  )
}

/**
 * 改过的那几样 → 一份新策略：已选 = 勾着的（不超过追几条），其余回候选；带品牌名几条、各方向占几条按勾着的重算。
 */
export function editedStrategy(
  base: GeoWatchStrategy,
  edit: {
    limit: number
    picked: readonly string[]
    platforms: readonly AiPlatform[]
    competitors: readonly BrandWatchCompetitor[]
  },
): GeoWatchStrategy {
  const all = [...base.prompts, ...base.candidates]
  const picked = edit.picked.slice(0, edit.limit)
  const prompts: GeoQuestion[] = picked
    .map((id) => all.find((q) => q.id === id))
    .filter((q): q is GeoQuestion => q !== undefined)
    .map((q) => ({ ...q, selected: true }))
  const candidates = all
    .filter((q) => !picked.includes(q.id))
    .map((q) => ({ ...q, selected: false }))
  const mix = new Map<string, number>()
  for (const q of prompts) mix.set(q.topic ?? 'other', (mix.get(q.topic ?? 'other') ?? 0) + 1)
  return {
    ...base,
    prompt_limit: edit.limit,
    branded: prompts.filter((q) => q.branded === true).length,
    topic_mix: [...mix.entries()].map(
      ([topic, count]) => ({ topic, count }) as GeoStrategyTopicShare,
    ),
    prompts,
    candidates,
    platforms: [...edit.platforms],
    competitors: [...edit.competitors],
  }
}

export function useApprove(card: DeckCard) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (edited: GeoWatchCardPayload | undefined) =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          ...(edited === undefined ? {} : { edited_payload: edited }),
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['geo-watch'] })
    },
  })
}

function SetupBody({ card, payload }: { card: DeckCard; payload: SetupPayload }): ReactNode {
  const { t } = useApp()
  const s = payload.strategy
  const est = payload.estimate
  const approve = useApprove(card)
  const [editing, setEditing] = useState(false)
  const [limit, setLimit] = useState(s.prompt_limit)
  const [picked, setPicked] = useState<string[]>(s.prompts.map((q) => q.id))
  const [platforms, setPlatforms] = useState<AiPlatform[]>([...s.platforms])
  const [rivals, setRivals] = useState<BrandWatchCompetitor[]>([...s.competitors])
  const decidable = card.available_actions.includes('approve')
  const names = (ps: readonly AiPlatform[]): string =>
    ps.map((p) => t(`geo.platform.${p}`)).join('、')
  const month = est.credits_per_month
  const all = [...s.prompts, ...s.candidates]
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-geo-watch-setup">
      <ul className="flex flex-col gap-0.5 text-[13px] text-ws-body" data-slot="data">
        <li>{t('geo.card.prompts', { n: String(s.prompt_limit), b: String(s.branded) })}</li>
        <li className="flex items-center gap-1">
          {t('geo.card.platforms', { names: names(s.platforms) })}
          {s.platforms.includes('claude') ? <Hint text={t('geo.claude.hint')} /> : null}
        </li>
        {s.competitors.length === 0 ? null : (
          <li>
            {t('geo.card.competitors', { names: s.competitors.map((c) => c.name).join('、') })}
          </li>
        )}
        {month === undefined ? null : (
          <li data-testid="deck-geo-watch-cost">
            {est.claude_credits_per_month === undefined
              ? t('geo.card.cost_plain', { m: String(month) })
              : t('geo.card.cost', { m: String(month), c: String(est.claude_credits_per_month) })}
          </li>
        )}
      </ul>
      {!decidable ? null : !editing ? (
        <Button
          size="xs"
          variant="outline"
          className="w-fit"
          data-testid="deck-geo-watch-edit"
          onClick={() => setEditing(true)}
        >
          {t('geo.card.edit')}
        </Button>
      ) : (
        <form
          className="flex flex-col gap-2.5 rounded-lg border border-ws-line p-2.5"
          data-testid="deck-geo-watch-form"
          onSubmit={(e) => {
            e.preventDefault()
            approve.mutate({
              ...payload,
              strategy: editedStrategy(s, { limit, picked, platforms, competitors: rivals }),
            })
          }}
        >
          <div className="flex items-center gap-1 text-xs">
            <span className="text-ws-muted-fg">{t('geo.watch.limit')}</span>
            {GEO_PROMPT_TIERS.map((n) => (
              <Button
                key={n}
                type="button"
                size="xs"
                variant={limit === n ? 'secondary' : 'ghost'}
                aria-pressed={limit === n}
                onClick={() => setLimit(n)}
              >
                {n}
              </Button>
            ))}
          </div>
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto text-[13px]">
            {all.map((q) => {
              const on = picked.includes(q.id)
              return (
                <li key={q.id}>
                  <label className="flex items-start gap-1.5">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={on}
                      disabled={!on && picked.length >= limit}
                      data-testid="deck-geo-watch-prompt"
                      onChange={(e) =>
                        setPicked(
                          e.target.checked ? [...picked, q.id] : picked.filter((id) => id !== q.id),
                        )
                      }
                    />
                    <span>
                      {q.text}
                      <span className="ml-1 text-xs text-ws-muted-fg">
                        {t(`geo.topic.${q.topic ?? 'other'}`)}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            {[...new Set([...BRAND_WATCH_DEFAULT_PLATFORMS, ...s.platforms])].map((p) => (
              <label key={p} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={platforms.includes(p)}
                  data-testid={`deck-geo-watch-platform-${p}`}
                  onChange={(e) =>
                    setPlatforms(
                      e.target.checked ? [...platforms, p] : platforms.filter((x) => x !== p),
                    )
                  }
                />
                {t(`geo.platform.${p}`)}
              </label>
            ))}
          </div>
          {rivals.length === 0 ? null : (
            <div className="flex flex-wrap gap-1">
              {rivals.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex h-6 items-center gap-1 rounded-md bg-ws-surface pl-2 pr-1 text-xs"
                >
                  {c.name}
                  <button
                    type="button"
                    aria-label={`${t('geo.watch.remove')} ${c.name}`}
                    onClick={() => setRivals(rivals.filter((x) => x.id !== c.id))}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={approve.isPending || picked.length === 0 || platforms.length === 0}
              data-testid="deck-geo-watch-save"
            >
              {t('geo.card.edit.done')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('geo.card.edit.cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

function RivalsBody({ card, payload }: { card: DeckCard; payload: RivalsPayload }): ReactNode {
  const { t } = useApp()
  const approve = useApprove(card)
  const [keep, setKeep] = useState<string[]>(payload.competitors.map((c) => c.id))
  const decidable = card.available_actions.includes('approve')
  const changed = keep.length !== payload.competitors.length
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-geo-watch-rivals">
      <ul className="flex flex-col gap-1 text-[13px]">
        {payload.competitors.map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={keep.includes(c.id)}
                disabled={!decidable}
                onChange={(e) =>
                  setKeep(e.target.checked ? [...keep, c.id] : keep.filter((id) => id !== c.id))
                }
              />
              <span className="font-medium">{c.name}</span>
              <span className="text-xs text-ws-muted-fg">
                {c.answers > 0
                  ? t('geo.card.rivals.answers', { n: String(c.answers) })
                  : t('geo.card.rivals.from_profile')}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {decidable && changed && keep.length > 0 ? (
        <Button
          size="sm"
          className="w-fit"
          disabled={approve.isPending}
          data-testid="deck-geo-watch-rivals-save"
          onClick={() =>
            approve.mutate({
              ...payload,
              competitors: payload.competitors.filter((c) => keep.includes(c.id)),
            })
          }
        >
          {t('geo.card.edit.done')}
        </Button>
      ) : null}
    </div>
  )
}

export function GeoWatchCardBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: GeoWatchCardPayload
}): ReactNode {
  if (payload.form === 'geo_consistency')
    return <ConsistencyCardBody card={card} payload={payload} />
  if (payload.form === 'geo_recheck') return <RecheckCardBody payload={payload} />
  return payload.form === 'geo_watch_setup' ? (
    <SetupBody card={card} payload={payload} />
  ) : (
    <RivalsBody card={card} payload={payload} />
  )
}

/**
 * WP335（docs/99 §5.1，O3）：第三栏「设定」里的 **关注设置**（只在「内容与搜索」这条职责层出）。
 * 替掉原来职责页上的手写面板 `geo-questions.tsx`（看板只留组件，设置收进「设定」）。
 *
 * - 花多少写在明处：这一轮 / 每月多少积分、Claude 那一格旁写它一个月多少（数是服务端算的）；
 * - 每样改了立刻存（`PUT /v1/seo/watch`，每样单给）；问题改字 = 旧的留在历史里、新开一条；
 * - 「让 AI 重新建议」= 出一张设定卡（决定只在卡片流）；
 * - 不写取数方式与批发商名；长说明进问号。
 */
import {
  BRAND_WATCH_DEFAULT_PLATFORMS,
  type BrandWatch,
  type BrandWatchFrequency,
  GEO_PROMPT_TIERS,
  type GeoPromptTopic,
  type GeoQuestion,
  type GeoWatchPatch,
  type GeoWatchView,
} from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Plus, Sparkles, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { marketLabel } from '@/components/onboarding/markets-picker'
import type { RailScope } from '@/components/rail/rail-scope'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { runSeo } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { getGeoWatch, setGeoWatch, suggestGeoWatch } from '@/lib/geo-watch-api'
import { cn } from '@/lib/utils'

const FREQUENCIES: BrandWatchFrequency[] = ['weekly', 'biweekly', 'monthly', 'manual']
const DEVICES: BrandWatch['rank_device'][] = ['mobile', 'desktop', 'both']

function Section({
  title,
  children,
  hint,
}: {
  title: string
  children: ReactNode
  hint?: string
}): ReactNode {
  return (
    <section className="flex flex-col gap-1.5">
      <h5
        className="flex items-center gap-1 text-xs font-medium text-ws-muted-fg"
        data-slot="title"
      >
        {title}
        {hint === undefined ? null : <Hint text={hint} />}
      </h5>
      {children}
    </section>
  )
}

function Chip({
  text,
  onRemove,
  label,
}: {
  text: string
  onRemove(): void
  label: string
}): ReactNode {
  return (
    <span
      className="inline-flex h-6 items-center gap-1 rounded-md bg-ws-surface pl-2 pr-1 text-xs"
      data-slot="data"
    >
      {text}
      <button
        type="button"
        aria-label={`${label} ${text}`}
        onClick={onRemove}
        className="rounded-sm hover:bg-ws-line"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  )
}

/** 一行「输入 + 加」。 */
function AddRow({
  placeholder,
  onAdd,
  testId,
}: {
  placeholder: string
  onAdd(v: string): void
  testId: string
}): ReactNode {
  const { t } = useApp()
  const [v, setV] = useState('')
  const add = (): void => {
    if (v.trim() === '') return
    onAdd(v.trim())
    setV('')
  }
  return (
    <div className="flex items-center gap-1.5">
      <Input
        className="h-7 text-xs"
        value={v}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add()
        }}
      />
      <Button size="xs" variant="outline" disabled={v.trim() === ''} onClick={add}>
        <Plus className="size-3" aria-hidden />
        {t('geo.watch.add')}
      </Button>
    </div>
  )
}

/** 一条在追的问题：勾掉 = 不追了（回候选）；改字失焦才存（旧的留在历史里）。 */
function PromptRow({
  q,
  onUnselect,
  onEdit,
}: {
  q: GeoQuestion
  onUnselect(): void
  onEdit(text: string): void
}): ReactNode {
  const { t } = useApp()
  const [text, setText] = useState(q.text)
  return (
    <li className="flex items-center gap-1.5" data-testid="geo-watch-prompt" data-id={q.id}>
      <input type="checkbox" checked aria-label={t('geo.watch.unselect')} onChange={onUnselect} />
      <Input
        className="h-7 text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() !== '' && text.trim() !== q.text) onEdit(text.trim())
        }}
      />
    </li>
  )
}

function Body({ view, assignment }: { view: GeoWatchView; assignment: string }): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const w = view.watch
  const [showCandidates, setShowCandidates] = useState(false)
  const [rival, setRival] = useState({ name: '', domain: '' })
  const save = useMutation({
    mutationFn: (patch: GeoWatchPatch) => setGeoWatch(patch, assignment),
    onSuccess: (next) => {
      client.setQueryData(['geo-watch', assignment], next)
    },
  })
  const suggest = useMutation({
    mutationFn: () => suggestGeoWatch({ card: true }, assignment),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['geo-watch', assignment] })
    },
  })
  const est = view.estimate
  const cost =
    est.route === 'byo'
      ? t('geo.watch.cost.byo')
      : est.route === 'none' || est.credits === undefined
        ? t('geo.watch.cost.none')
        : // 文案里本来就是「约」，单价是兜底估的也不再多加记号
          t('geo.watch.cost', {
            c: String(est.credits),
            m: String(est.credits_per_month ?? 0),
          })
  const platforms = [...new Set([...BRAND_WATCH_DEFAULT_PLATFORMS, ...w.platforms])]
  const selectedIds = w.prompts.map((p) => p.id)
  const full = w.prompts.length >= w.prompt_limit
  const groups = new Map<GeoPromptTopic, GeoQuestion[]>()
  for (const q of w.prompt_candidates) {
    const topic = q.topic ?? 'other'
    groups.set(topic, [...(groups.get(topic) ?? []), q])
  }
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="geo-watch-settings">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium" data-slot="status" data-testid="geo-watch-setup">
            {t(`geo.watch.setup.${view.setup}`)}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={suggest.isPending}
            onClick={() => suggest.mutate()}
            data-testid="geo-watch-suggest"
          >
            <Sparkles className="size-3" aria-hidden />
            {t('geo.watch.suggest')}
          </Button>
        </div>
        {suggest.isSuccess ? (
          <p className="text-xs text-ws-muted-fg" data-slot="status">
            {t('geo.watch.suggested')}
          </p>
        ) : null}
        <p className="text-xs text-ws-muted-fg" data-slot="status" data-testid="geo-watch-cost">
          {cost}
        </p>
        {view.notes.map((n) => (
          <p key={n} className="text-xs text-ws-warn" data-slot="status">
            {n}
          </p>
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Switch
          id="geo-watch-enabled"
          checked={w.enabled}
          onCheckedChange={(v) => save.mutate({ enabled: v })}
          data-testid="geo-watch-enabled"
        />
        <label htmlFor="geo-watch-enabled">{t('geo.watch.enabled')}</label>
      </div>
      <Section title={t('geo.watch.platforms')}>
        <div className="flex flex-col gap-1">
          {platforms.map((p) => (
            <label key={p} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={w.platforms.includes(p)}
                data-testid={`geo-watch-platform-${p}`}
                onChange={(e) =>
                  save.mutate({
                    platforms: e.target.checked
                      ? [...w.platforms, p]
                      : w.platforms.filter((x) => x !== p),
                  })
                }
              />
              {t(`geo.platform.${p}`)}
              {p === 'claude' ? (
                <>
                  {est.claude_credits_per_month === undefined ? null : (
                    <span
                      className="text-xs text-ws-muted-fg"
                      data-slot="status"
                      data-testid="geo-watch-claude-cost"
                    >
                      {t('geo.watch.claude_month', { c: String(est.claude_credits_per_month) })}
                    </span>
                  )}
                  <Hint text={t('geo.claude.hint')} />
                </>
              ) : null}
            </label>
          ))}
        </div>
      </Section>
      <Section title={t('geo.watch.limit')}>
        <div className="flex items-center gap-1">
          {GEO_PROMPT_TIERS.filter((n) => n <= w.prompt_cap).map((n) => (
            <Button
              key={n}
              size="xs"
              variant={w.prompt_limit === n ? 'secondary' : 'ghost'}
              aria-pressed={w.prompt_limit === n}
              onClick={() => save.mutate({ prompt_limit: n })}
            >
              {n}
            </Button>
          ))}
        </div>
      </Section>
      <Section
        title={`${t('geo.watch.prompts')} ${w.prompts.length}/${w.prompt_limit}`}
        hint={t('geo.watch.edit.hint')}
      >
        <ul className="flex flex-col gap-1">
          {w.prompts.map((q) => (
            <PromptRow
              key={q.id}
              q={q}
              onUnselect={() => save.mutate({ select: selectedIds.filter((id) => id !== q.id) })}
              onEdit={(text) => save.mutate({ edit_prompts: [{ id: q.id, text }] })}
            />
          ))}
        </ul>
        <AddRow
          placeholder={t('geo.watch.add_prompt')}
          testId="geo-watch-add-prompt"
          onAdd={(text) => save.mutate({ add_prompts: [{ text, selected: !full }] })}
        />
        {w.prompt_candidates.length === 0 ? null : (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              className="ws-link-muted flex items-center gap-1 text-xs"
              aria-expanded={showCandidates}
              data-testid="geo-watch-candidates-toggle"
              onClick={() => setShowCandidates(!showCandidates)}
            >
              {showCandidates ? (
                <ChevronDown className="size-3" aria-hidden />
              ) : (
                <ChevronRight className="size-3" aria-hidden />
              )}
              {t('geo.watch.candidates', { n: String(w.prompt_candidates.length) })}
            </button>
            {showCandidates
              ? [...groups.entries()].map(([topic, list]) => (
                  <div key={topic} className="flex flex-col gap-0.5 pl-4">
                    <span className="text-xs text-ws-muted-fg">{t(`geo.topic.${topic}`)}</span>
                    {list.map((q) => (
                      <div
                        key={q.id}
                        className="flex items-center gap-1.5 text-xs"
                        data-testid="geo-watch-candidate"
                      >
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={t('geo.watch.select')}
                          disabled={full}
                          onClick={() => save.mutate({ select: [...selectedIds, q.id] })}
                        >
                          <Plus className="size-3" aria-hidden />
                        </Button>
                        <span className="min-w-0 flex-1">{q.text}</span>
                      </div>
                    ))}
                  </div>
                ))
              : null}
          </div>
        )}
      </Section>
      <Section title={t('geo.watch.brand')}>
        <span className="text-sm font-medium" data-slot="data">
          {w.brand.name}
        </span>
        <div className="flex flex-wrap gap-1">
          {w.brand.aliases.map((a) => (
            <Chip
              key={a}
              text={a}
              label={t('geo.watch.remove')}
              onRemove={() =>
                save.mutate({ brand_aliases: w.brand.aliases.filter((x) => x !== a) })
              }
            />
          ))}
        </div>
        <AddRow
          placeholder={t('geo.watch.add_alias')}
          testId="geo-watch-add-alias"
          onAdd={(v) => save.mutate({ brand_aliases: [...w.brand.aliases, v] })}
        />
      </Section>
      <Section title={t('geo.watch.competitors')}>
        <div className="flex flex-wrap gap-1" data-testid="geo-watch-competitors">
          {w.competitors.map((c) => (
            <Chip
              key={c.id}
              text={c.domains[0] === undefined ? c.name : `${c.name} · ${c.domains[0]}`}
              label={t('geo.watch.remove')}
              onRemove={() =>
                save.mutate({ competitors: w.competitors.filter((x) => x.id !== c.id) })
              }
            />
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            className="h-7 text-xs"
            value={rival.name}
            placeholder={t('geo.watch.competitor.name')}
            data-testid="geo-watch-rival-name"
            onChange={(e) => setRival({ ...rival, name: e.target.value })}
          />
          <Input
            className="h-7 text-xs"
            value={rival.domain}
            placeholder={t('geo.watch.competitor.domain')}
            onChange={(e) => setRival({ ...rival, domain: e.target.value })}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={rival.name.trim() === ''}
            data-testid="geo-watch-add-rival"
            onClick={() => {
              const name = rival.name.trim()
              const domain = rival.domain
                .trim()
                .toLowerCase()
                .replace(/^https?:\/\//, '')
                .replace(/\/.*$/, '')
              save.mutate({
                competitors: [
                  ...w.competitors,
                  {
                    id: `c_${name.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '_')}`,
                    name,
                    aliases: [],
                    domains: domain === '' ? [] : [domain],
                  },
                ],
              })
              setRival({ name: '', domain: '' })
            }}
          >
            <Plus className="size-3" aria-hidden />
            {t('geo.watch.add')}
          </Button>
        </div>
      </Section>
      <Section title={t('geo.watch.keywords')}>
        <div className="flex flex-wrap gap-1">
          {w.keywords.map((k) => (
            <Chip
              key={k.keyword}
              text={k.keyword}
              label={t('geo.watch.remove')}
              onRemove={() =>
                save.mutate({ keywords: w.keywords.filter((x) => x.keyword !== k.keyword) })
              }
            />
          ))}
        </div>
        <AddRow
          placeholder={t('geo.watch.add_keyword')}
          testId="geo-watch-add-keyword"
          onAdd={(keyword) =>
            save.mutate({
              keywords: [
                ...w.keywords,
                {
                  keyword,
                  branded: keyword.toLowerCase().includes(w.brand.name.toLowerCase()),
                  enabled: true,
                },
              ],
            })
          }
        />
      </Section>
      {w.markets.length < 2 ? null : (
        <Section title={t('geo.watch.markets')}>
          <div className="flex flex-wrap gap-2">
            {w.markets.map((m) => (
              <label key={m} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={!(w.markets_off ?? []).includes(m)}
                  onChange={(e) =>
                    save.mutate({
                      markets_off: e.target.checked
                        ? (w.markets_off ?? []).filter((x) => x !== m)
                        : [...(w.markets_off ?? []), m],
                    })
                  }
                />
                {marketLabel(m, lang)}
              </label>
            ))}
          </div>
        </Section>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-ws-muted-fg">
          {t('geo.watch.frequency')}
          <select
            className="h-7 rounded-md border bg-transparent px-1 text-sm text-ws-ink"
            value={w.frequency}
            data-testid="geo-watch-frequency"
            onChange={(e) => save.mutate({ frequency: e.target.value as BrandWatchFrequency })}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {t(`geo.watch.frequency.${f}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ws-muted-fg">
          {t('geo.watch.device')}
          <select
            className="h-7 rounded-md border bg-transparent px-1 text-sm text-ws-ink"
            value={w.rank_device}
            onChange={(e) =>
              save.mutate({ rank_device: e.target.value as BrandWatch['rank_device'] })
            }
          >
            {DEVICES.map((d) => (
              <option key={d} value={d}>
                {t(`geo.watch.device.${d}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ReadConsoleNow assignment={assignment} />
      {save.error === null ? null : (
        <p className={cn('text-xs text-destructive')} data-slot="error">
          {save.error.message}
        </p>
      )}
    </div>
  )
}

/**
 * 原来手写面板上的「现在读一遍 Search Console」（每天早上那一轮的手动版）挪到这里，别的不变；
 * 每周那一轮 GEO 的手动版是看板上的「现在跑一轮」。
 */
function ReadConsoleNow({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const run = useMutation({
    mutationFn: () => runSeo('daily', assignment),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['view'] })
    },
  })
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="ghost" disabled={run.isPending} onClick={() => run.mutate()}>
        {t('seo.run.daily')}
      </Button>
      {run.data === undefined ? null : (
        <span className="text-xs text-ws-muted-fg" data-slot="status">
          {run.data.skipped ?? t('seo.run.done')}
        </span>
      )}
    </div>
  )
}

export function GeoWatchSettings({ assignment }: { assignment: string }): ReactNode {
  const view = useQuery({
    queryKey: ['geo-watch', assignment],
    queryFn: () => getGeoWatch(assignment),
  })
  if (view.data === undefined) return null
  return <Body view={view.data} assignment={assignment} />
}

/** 「设定」里那个标签（职责层才有分配；拿不到就说一句）。 */
export function GeoWatchSettingsPanel({ scope }: { scope: RailScope }): ReactNode {
  const { t } = useApp()
  if (scope.tier !== 'role' || scope.scope_id !== 'dtc.seo' || scope.assignment === undefined)
    return <p className="text-sm text-ws-muted-fg">{t('geo.watch.only_duty')}</p>
  return <GeoWatchSettings assignment={scope.assignment} />
}

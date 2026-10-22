/**
 * 输入框左下角的 **AI 钮**（WP188 随便聊顶上的模型下拉 → WP342 决策 853：所有输入框共用这一个；
 * WP362 Luoye 10-16：学 Proma 的样子）。岗位页、事项、线程、助理、⌘K 交给岗位共用这一个件。
 *
 * - 顶上一个「搜索模型…」，按模型名、厂商、来源过滤；
 * - 按来源分组：「Agents 工坊（积分）」（云端价目里能用的全部模型）、「ChatGPT 订阅」、自己接的各家；
 *   组标题带图标，右边挂余额（工坊那组：个人 / 同事互联写余额，公司模式写这个人本月还剩多少）；
 * - 每行：厂商图标 + 模型名；右边是消耗速率（DeepSeek v4 Pro 官方原价 = 1x）/ 限免 / 订阅额度 /
 *   用你自己的 key，能不能看图是一个小标签，选中的打勾；
 * - WP363（决策 954）：价目里这个模型有折扣，就在倍率旁边写「1 折」（没有不显示）；倍率仍是原价口径；
 * - 钮上：「来源 · 模型名」；工坊积分那组沿用只画工坊标记的规矩（决策 853），悬停出全名；
 * - 选了只改**这一次对话 / 这件事**（调用方存）；「设为默认」改品牌默认（只有所有者有）；底部「管理模型…」；
 * - 一个都没接：钮换成「还没接 AI」，点了在第三栏开「接模型」连接卡（WP334，不跳设置页）。
 *
 * WP370（Luoye 10-17，照官方 dsh alpha.5 的模型选择）：
 * - 每行用目录里的**显示名**（GPT-5.5、DeepSeek-V4.1-Flash），id 只在悬停里；
 * - 能力小标：看图 / 自带联网 / 长上下文（≥ 20 万 token），只画图标，悬停出一句话；
 * - **思考程度**：当前模型声明了档位才出「思考：快 / 标准 / 深度」一行（官方：没声明就不出）；
 *   换模型回到那个模型的默认档；钮上只有不是默认档时才多写「· 深度」；
 * - 搜索照官方：模型多于 4 个才出；按名字不连续也能对上（gpt55 → GPT-5.5），前缀对上的排前面。
 *
 * WP373（Luoye 10-17，决策 977 / 979 复核）：
 * - 思考程度从菜单里挪出来，成了 AI 钮右边一个**独立的小钮**（学 Claude Code 输入框的「Opus · High」）：
 *   钮上直接写当前这一档，点一下弹「快 / 标准 / 深度」；官方只声明了开 / 关的模型画成开关；没声明的不出这个钮；
 * - 这次 / 这件事选的模型后来用不了（删了、没接上）：照旧退回默认跑，钮上亮一个小黄点，悬停说原来选的是哪个。
 *
 * 一个轻量的下拉，不用弹层库。键盘：↑↓ 换（搜索框里按 ↓ 进清单）、回车选、Esc 收起并回到钮上。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Search, TriangleAlert } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrandIcon } from '@/components/brand-icons'
import { BrandMark } from '@/components/design'
import { hasVendorIcon, VendorIcon } from '@/components/models/vendor-icon'
import { settingsHref } from '@/components/settings-panel/route'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { Hint } from '@/components/ui/hint'
import { getCloudCredits, getMyCloudAllocation, getPositions, setModelDefaults } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { type FreeChatModelChoice, getFreeChatModels, type ReasoningEffort } from '@/lib/free-chat'
import { useMode } from '@/lib/mode'
import { type CapabilityMarks, capabilityMarks, compactChoices } from '@/lib/model-picker-compact'
import { cn } from '@/lib/utils'
import { ThinkingControl } from './thinking-control'

/** `provider_id/model` 的模型名那一半。 */
export const modelNameOf = (id: string): string => id.slice(id.indexOf('/') + 1)

/** 随便聊与各输入框共用的那一份已接模型清单（查询键与随便聊页同一个）。 */
export const MODEL_CHOICES_KEY = ['free-chat', 'models'] as const

type Group = NonNullable<FreeChatModelChoice['group']>

/** 这一项属于哪一组（老服务端没有 `group`：按 `official` 兜）。 */
const groupOf = (c: FreeChatModelChoice): Group =>
  c.group ?? (c.official ? 'workshop' : c.id.startsWith('openai-codex/') ? 'subscription' : 'own')

/** WP370：一行给人看的名字（目录里有显示名就用它，没有就是 id 里的模型名）。 */
export const displayNameOf = (c: Pick<FreeChatModelChoice, 'id' | 'name'>): string =>
  c.name !== undefined && c.name.trim() !== '' ? c.name : modelNameOf(c.id)

/** WP370：上下文窗口到多少算「长上下文」（与服务端同一条线）。 */
export const LONG_CONTEXT_TOKENS = 200_000

/**
 * WP370：照官方 `rankByName` 的意思——忽略大小写、去掉首尾空格，名字里按顺序出现这些字（可以不连续）就算对上；
 * 前缀对上的排前面，再按对得紧不紧，最后保持原来的顺序。回 `undefined` = 对不上。
 */
export function matchScore(query: string, text: string): number | undefined {
  const q = query.trim().toLowerCase()
  if (q === '') return 0
  const t = text.toLowerCase()
  if (t.startsWith(q)) return 0
  const at = t.indexOf(q)
  if (at >= 0) return 1 + at / 1000
  let i = 0
  let gaps = 0
  let last = -1
  for (const ch of q) {
    const found = t.indexOf(ch, last + 1)
    if (found < 0) return undefined
    if (last >= 0) gaps += found - last - 1
    last = found
    i += 1
  }
  return i === 0 ? undefined : 2 + gaps / 100
}

/** 来源的短名（钮上「来源 · 模型名」那一半）：「DeepSeek 官方 · 官方 API 接口连接」取前半。 */
const shortSource = (label: string): string => label.split(' · ')[0] ?? label

export function ChoiceIcon({
  choice,
  size = 16,
}: {
  choice: Pick<FreeChatModelChoice, 'id' | 'official'> & { vendor?: string | undefined }
  size?: number
}): React.ReactNode {
  if (choice.official) return <BrandMark size={size} playOnHover />
  if (hasVendorIcon(choice.vendor))
    return <VendorIcon vendor={choice.vendor as string} size={size} />
  return <BrandIcon provider={choice.id.slice(0, choice.id.indexOf('/'))} size={size} />
}

/** 工坊积分那组标题右边那一格（余额 / 本月还剩）；问不到就不画。 */
export interface PickerBalance {
  kind: 'balance' | 'member_left'
  credits: number
}

/** 「1.0x」「2.3x」「0.07x」「12x」（与服务端 `formatRate` 同一个写法）。 */
export function formatRate(rate: number): string {
  if (rate >= 10) return `${Math.round(rate)}x`
  if (rate >= 0.1) return `${(Math.round(rate * 10) / 10).toFixed(1)}x`
  return `${Math.max(0.01, Math.round(rate * 100) / 100)}x`
}

/**
 * WP363（决策 954）：折扣那一格。中文写「1 折」「8.5 折」（折数 = 折扣 × 10，保留一位小数）；
 * WP364（决策 958）：折扣 = 我们的售价 ÷ 这家官方标价（按 token 构成），只是说明、不另外少扣；
 * 英文写「90% off」。只认 `0 < d < 1`（服务端已经按 `pricingDiscountOf` 筛过，这里再兜一次）。
 */
export function discountLabel(
  discount: number,
  locale: 'zh' | 'en',
): { text: string; pct: number } | undefined {
  if (!Number.isFinite(discount) || discount <= 0 || discount >= 1) return undefined
  const pct = Math.min(99, Math.max(1, Math.round(discount * 100)))
  if (locale === 'en') return { text: `${String(100 - pct)}% off`, pct }
  const zhe = Math.min(9.9, Math.max(0.1, Math.round(discount * 100) / 10))
  return { text: `${String(zhe)} 折`, pct }
}

const creditsText = (n: number): string =>
  n >= 100 ? String(Math.round(n)) : String(Math.round(n * 100) / 100)

interface PickerGroup {
  key: string
  group: Group
  label: string
  sample: FreeChatModelChoice
  rows: FreeChatModelChoice[]
}

export function ModelPicker({
  choices,
  value,
  onChange,
  defaultId,
  onSetDefault,
  placement = 'up',
  testId = 'model-pick',
  rateBase,
  balance,
  effort,
  onEffortChange,
}: {
  choices: FreeChatModelChoice[]
  /** 这一次 / 这件事选的（不给 = 跟默认走）。 */
  value: string | undefined
  onChange: (id: string) => void
  /** 品牌默认那一个（菜单里标「默认」；与当前相同就不出「设为默认」）。 */
  defaultId?: string | undefined
  /** 「设为默认」（不给 = 不出这一项：不是所有者改不了品牌默认）。 */
  onSetDefault?: ((id: string) => void) | undefined
  /** 菜单往上开（输入框在页面底部）还是往下开。 */
  placement?: 'up' | 'down'
  testId?: string
  /** WP362：消耗速率的 1x 是谁（`fallback` = 价目里没有 DeepSeek v4 Pro）。 */
  rateBase?: { model: string; fallback: boolean } | undefined
  /** WP362：工坊积分那组标题右边的余额 / 本月还剩。 */
  balance?: PickerBalance | undefined
  /** WP370：这一次 / 这件事选的思考程度（不给 = 当前模型的默认档）。 */
  effort?: ReasoningEffort | undefined
  /** WP370：调思考程度（连同当前模型一起存）；不给 = 不出「思考」那一行。 */
  onEffortChange?: ((effort: ReasoningEffort, model: string) => void) | undefined
}): React.ReactNode {
  const { t, lang } = useApp()
  const openConnect = useOpenConnect()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  /**
   * 往哪边开、清单最高多少：按钮上下各剩多少地方现量（输入框在页面中间时往上开会顶出窗口）。
   * 想往上开但上面不够、下面更宽就往下开；清单高度不超过那一边剩下的地方。
   */
  const [layout, setLayout] = useState<{ dir: 'up' | 'down'; max: number }>({
    dir: placement,
    max: 420,
  })
  useLayoutEffect(() => {
    if (!open) return
    const r = trigger.current?.getBoundingClientRect()
    const vh = globalThis.innerHeight
    if (r === undefined || vh === undefined || vh === 0) return
    const above = r.top - 12
    const below = vh - r.bottom - 12
    // 搜索框 + 底部两行大约占这么高
    const chrome = 110
    let dir = placement
    if (placement === 'up' && above < 320 && below > above) dir = 'down'
    if (placement === 'down' && below < 320 && above > below) dir = 'up'
    const room = (dir === 'up' ? above : below) - chrome
    setLayout({ dir, max: Math.max(140, Math.min(420, room)) })
  }, [open, placement])

  // 点外面收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    globalThis.document?.addEventListener('mousedown', onDown)
    return () => {
      globalThis.document?.removeEventListener('mousedown', onDown)
    }
  }, [open])

  // 开了就把焦点放到选中的那一项（键盘可达）；收起时清掉搜索
  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
    const selected = list.find((el) => el.getAttribute('aria-selected') === 'true') ?? list[0]
    selected?.focus()
    selected?.scrollIntoView?.({ block: 'nearest' })
  }, [open])

  // 按来源分组：工坊积分 → ChatGPT 订阅 → 自己接的各家（一家一组）；组内保持服务端给的顺序
  const groups = useMemo((): PickerGroup[] => {
    const q = query.trim()
    // WP370：名字（显示名 / id 里的模型名）按官方的松匹配；厂商、来源仍按包含
    const scoreOf = (c: FreeChatModelChoice): number | undefined => {
      if (q === '') return 0
      const names = [displayNameOf(c), modelNameOf(c.id)]
        .map((n) => matchScore(q, n))
        .filter((x): x is number => x !== undefined)
      if (names.length > 0) return Math.min(...names)
      const lower = q.toLowerCase()
      return (c.vendor ?? '').toLowerCase().includes(lower) || c.label.toLowerCase().includes(lower)
        ? 3
        : undefined
    }
    /*
     * WP426：不搜的时候清单收短——实验 / 预览型号不进、别名与带版本号的同一个只留一个
     * （当前选着的、品牌默认的永远留着）；一搜就整份都在。
     */
    const keep = new Set([value, defaultId].filter((x): x is string => x !== undefined))
    const pool = q === '' ? compactChoices(choices, keep) : choices
    const scored = pool
      .map((c, i) => ({ c, i, score: scoreOf(c) }))
      .filter(
        (x): x is { c: FreeChatModelChoice; i: number; score: number } => x.score !== undefined,
      )
      .sort((a, b) => a.score - b.score || a.i - b.i)
    const out: PickerGroup[] = []
    for (const { c } of scored) {
      const group = groupOf(c)
      const key = group === 'own' ? `own:${c.id.slice(0, c.id.indexOf('/'))}` : group
      let g = out.find((x) => x.key === key)
      if (g === undefined) {
        g = {
          key,
          group,
          label:
            group === 'workshop'
              ? t('model.pick.group.workshop')
              : group === 'subscription'
                ? t('model.pick.group.subscription')
                : c.label,
          sample: c,
          rows: [],
        }
        out.push(g)
      }
      g.rows.push(c)
    }
    const rank = { workshop: 0, subscription: 1, own: 2 } as const
    return out.sort((a, b) => rank[a.group] - rank[b.group])
  }, [choices, query, t, value, defaultId])

  const close = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
    const active = globalThis.document?.activeElement as HTMLElement | null
    if (active === search.current) {
      ;(e.key === 'ArrowDown' ? list[0] : list.at(-1))?.focus()
      return
    }
    const at = list.indexOf(active as HTMLElement)
    // WP370：没出搜索框（模型不多于 4 个）时首尾相接
    if (e.key === 'ArrowUp' && at === 0 && search.current !== null) {
      search.current.focus()
      return
    }
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length
    list[next]?.focus()
  }

  const current =
    choices.find((c) => c.id === value) ?? choices.find((c) => c.id === defaultId) ?? choices[0]
  if (current === undefined) {
    return (
      // WP334（决策 726）/ WP342（857）：还没接模型——在第三栏就地接（与开工向导第 ① 步同一个件），不跳设置页
      <button
        type="button"
        title={t('model.pick.none.tip')}
        data-testid={`${testId}-none`}
        data-connect="model"
        className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-ws-warn-bg px-2.5 text-[12px] font-medium whitespace-nowrap text-ws-warn"
        onClick={() => {
          openConnect('model')
        }}
      >
        <TriangleAlert aria-hidden className="size-3.5" />
        {t('model.pick.none')}
      </button>
    )
  }
  const currentGroup = groupOf(current)
  const sourceName =
    currentGroup === 'workshop'
      ? t('model.pick.group.workshop')
      : currentGroup === 'subscription'
        ? t('model.pick.group.subscription')
        : shortSource(current.label)
  // WP373：思考程度挪到钮右边那个独立小钮（模型声明了档位、调用方接了回调才出）
  const thinking = onEffortChange === undefined ? undefined : current.thinking
  const full = t('model.pick.source_model', { source: sourceName, model: displayNameOf(current) })
  // WP373（决策 977）：选的那个现在不在清单里 → 这次退回了默认；钮上亮小黄点
  const stale =
    value !== undefined && value !== '' && !choices.some((c) => c.id === value)
      ? t('model.pick.stale', { name: modelNameOf(value) })
      : undefined
  // 读屏念的名字：工坊那组仍是「工坊」（决策 853），别的就是「来源 · 模型名」
  const name = current.official ? t('model.pick.workshop') : full

  const priceOf = (c: FreeChatModelChoice): RowPrice | undefined => {
    const p = c.price
    if (p === undefined) return undefined
    if (p.kind === 'rate') {
      const off = p.discount === undefined ? undefined : discountLabel(p.discount, lang)
      return {
        text: formatRate(p.rate),
        tip: t(p.source === 'stats' ? 'model.pick.rate.stats' : 'model.pick.rate.list_price'),
        ...(off === undefined
          ? {}
          : { discount: { text: off.text, tip: t('model.pick.discount.tip', { pct: off.pct }) } }),
      }
    }
    if (p.kind === 'free') return { text: t('model.pick.price.free') }
    if (p.kind === 'subscription') return { text: t('model.pick.price.subscription') }
    return { text: t('model.pick.price.own_key') }
  }
  const rateNote =
    rateBase?.fallback === true
      ? `${t('model.pick.rate.note')} ${t('model.pick.rate.fallback', { model: rateBase.model })}`
      : t('model.pick.rate.note')

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <div ref={box} className="relative min-w-0">
        <button
          ref={trigger}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={
            stale === undefined
              ? t('model.pick.aria', { name })
              : `${t('model.pick.aria', { name })}。${stale}`
          }
          title={
            stale === undefined
              ? t('model.pick.tip', { name: full })
              : `${stale}\n${t('model.pick.tip', { name: full })}`
          }
          data-testid={testId}
          data-model={current.id}
          {...(stale === undefined ? {} : { 'data-stale': value })}
          className="relative inline-flex h-[30px] max-w-[260px] items-center gap-1.5 rounded-full px-2 text-[12.5px] text-ws-muted-fg hover:bg-muted hover:text-ws-ink"
          onClick={() => {
            setOpen((o) => !o)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setOpen(true)
            }
          }}
        >
          <ChoiceIcon choice={current} />
          {current.official ? null : <span className="truncate">{full}</span>}
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
          {stale === undefined ? null : (
            <span
              aria-hidden
              data-testid={`${testId}-stale`}
              title={stale}
              className="absolute top-1 right-1 size-1.5 rounded-full bg-ws-warn ring-2 ring-background"
            />
          )}
        </button>
        {open ? (
          <div
            ref={menu}
            role="listbox"
            aria-label={t('free_chat.model.pick')}
            data-testid={`${testId}-menu`}
            onKeyDown={onMenuKey}
            className={cn(
              'absolute left-0 z-50 flex w-[360px] max-w-[calc(100vw-32px)] flex-col rounded-lg border bg-popover text-popover-foreground shadow-md',
              layout.dir === 'up' ? 'bottom-full mb-1' : 'top-full mt-1',
            )}
          >
            {/* WP370：照官方——模型多于 4 个才出搜索 */}
            {choices.length <= SEARCH_MIN ? null : (
              <label className="flex items-center gap-2 border-b px-3 py-2">
                <Search aria-hidden className="size-3.5 text-muted-foreground" />
                <input
                  ref={search}
                  type="search"
                  value={query}
                  placeholder={t('model.pick.search')}
                  aria-label={t('model.pick.search')}
                  data-testid={`${testId}-search`}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  onChange={(e) => {
                    setQuery(e.target.value)
                  }}
                />
              </label>
            )}
            <div className="overflow-y-auto p-1" style={{ maxHeight: layout.max }}>
              {groups.length === 0 ? (
                <p
                  className="px-2 py-3 text-center text-xs text-muted-foreground"
                  data-testid={`${testId}-empty`}
                >
                  {t('model.pick.empty')}
                </p>
              ) : null}
              {groups.map((g) => (
                <fieldset
                  key={g.key}
                  aria-label={g.label}
                  data-testid={`${testId}-group`}
                  data-group={g.group}
                  className="m-0 min-w-0 border-0 p-0"
                >
                  <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    {g.group === 'workshop' ? (
                      <BrandMark size={14} />
                    ) : g.group === 'subscription' ? (
                      <VendorIcon vendor="openai" size={14} />
                    ) : (
                      <BrandIcon
                        provider={g.sample.id.slice(0, g.sample.id.indexOf('/'))}
                        size={14}
                      />
                    )}
                    <span className="truncate">{g.label}</span>
                    {g.group === 'workshop' ? (
                      <Hint text={rateNote} testId={`${testId}-rate-note`} />
                    ) : null}
                    {g.group === 'workshop' && balance !== undefined ? (
                      <span
                        data-testid={`${testId}-balance`}
                        className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-xs font-normal tabular-nums"
                      >
                        {t(
                          balance.kind === 'member_left'
                            ? 'model.pick.member_left'
                            : 'model.pick.balance',
                          { n: creditsText(balance.credits) },
                        )}
                      </span>
                    ) : null}
                  </div>
                  {g.rows.map((c) => (
                    <PickerRow
                      key={c.id}
                      choice={c}
                      groupLabel={g.label}
                      selected={c.id === current.id}
                      isDefault={c.id === defaultId}
                      price={priceOf(c)}
                      marks={capabilityMarks(g.rows, LONG_CONTEXT_TOKENS)}
                      testId={testId}
                      onPick={() => {
                        onChange(c.id)
                        close()
                      }}
                    />
                  ))}
                </fieldset>
              ))}
            </div>
            <div className="flex flex-col border-t p-1">
              {onSetDefault === undefined || current.id === defaultId ? null : (
                <button
                  type="button"
                  data-menu-item
                  title={t('model.pick.default.tip')}
                  data-testid={`${testId}-set-default`}
                  className="rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() => {
                    onSetDefault(current.id)
                    close()
                  }}
                >
                  {t('model.pick.default')}
                </button>
              )}
              <Link
                // WP356：设置弹窗「AI → 模型」那一节
                to={settingsHref('models')}
                data-menu-item
                data-testid={`${testId}-manage`}
                className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                {t('free_chat.model.manage')}
              </Link>
            </div>
          </div>
        ) : null}
      </div>
      {thinking === undefined ? null : (
        <ThinkingControl
          key={current.id}
          testId={testId}
          thinking={thinking}
          effort={effort}
          placement={placement}
          onPick={(next) => {
            onEffortChange?.(next, current.id)
          }}
        />
      )}
    </div>
  )
}

/** 每行右边那一格（+ WP363 折扣小标签）。 */
interface RowPrice {
  text: string
  tip?: string
  discount?: { text: string; tip: string }
}

/** 清单里的一行：厂商图标 + 模型名（+「默认」）｜看图小标签 · 消耗速率 / 订阅额度 / 用你自己的 key · 勾。 */
function PickerRow({
  choice,
  groupLabel,
  selected,
  isDefault,
  price,
  marks,
  testId,
  onPick,
}: {
  choice: FreeChatModelChoice
  groupLabel: string
  selected: boolean
  isDefault: boolean
  price: RowPrice | undefined
  marks: CapabilityMarks
  testId: string
  onPick: () => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <button
      type="button"
      role="option"
      data-menu-item
      aria-selected={selected}
      data-testid={`${testId}-option`}
      data-model={choice.id}
      title={t('model.pick.source_model', { source: groupLabel, model: modelNameOf(choice.id) })}
      data-name={displayNameOf(choice)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      onClick={onPick}
    >
      <ChoiceIcon choice={{ id: choice.id, official: false, vendor: choice.vendor }} size={16} />
      <span className="min-w-0 truncate">{displayNameOf(choice)}</span>
      {isDefault ? (
        <span className="shrink-0 text-xs text-muted-foreground">{t('model.pick.is_default')}</span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {/*
          WP370 → WP426：能力小标只标例外，而且是看得懂的小字（悬停一句为什么）：
          看不了图的那几行写「不能看图」；自带联网、长上下文只在少数有的时候标出来。
        */}
        {marks.web && choice.native_search === true ? (
          <CapTag
            text={t('model.pick.cap.web.short')}
            tip={t('model.pick.cap.web')}
            testId={`${testId}-cap-web`}
          />
        ) : null}
        {marks.long && (choice.context_window ?? 0) >= LONG_CONTEXT_TOKENS ? (
          <CapTag
            text={t('model.pick.cap.long.short')}
            tip={t('model.pick.cap.long', {
              k: Math.round((choice.context_window ?? 0) / 1000),
            })}
            testId={`${testId}-cap-long`}
          />
        ) : null}
        {marks.noVision && choice.vision === 'no' ? (
          <CapTag
            text={t('model.pick.cap.no_vision.short')}
            tip={t('free_chat.model.no_vision')}
            testId={`${testId}-cap-no-vision`}
            warn
          />
        ) : null}
        {price?.discount === undefined ? null : (
          <span
            data-testid={`${testId}-discount`}
            className="rounded bg-ws-warn-bg px-1 text-xs text-ws-warn"
            title={price.discount.tip}
          >
            {price.discount.text}
          </span>
        )}
        {price === undefined ? null : (
          <span
            data-testid={`${testId}-price`}
            className="tabular-nums"
            {...(price.tip === undefined ? {} : { title: price.tip })}
          >
            {price.text}
          </span>
        )}
        <span className="inline-flex w-3.5 justify-center">
          {selected ? <Check aria-hidden className="size-3.5 text-ws-ink" /> : null}
        </span>
      </span>
    </button>
  )
}

/** WP426：一行里的能力小标——几个字 + 悬停一句（不是让人猜的小图标）。 */
function CapTag({
  text,
  tip,
  testId,
  warn = false,
}: {
  text: string
  tip: string
  testId: string
  warn?: boolean
}): React.ReactNode {
  return (
    <span
      data-testid={testId}
      title={tip}
      data-hint={tip}
      className={cn(
        'rounded px-1 text-xs leading-4',
        warn ? 'bg-ws-warn-bg text-ws-warn' : 'bg-muted text-muted-foreground',
      )}
    >
      {text}
    </span>
  )
}

/** WP370：模型多于这么多个才出搜索（官方 alpha.5 同一条线）。 */
const SEARCH_MIN = 4

/**
 * 工坊积分那组标题右边那一格：个人 / 同事互联写余额；公司模式写这个人本月还剩多少（设了上限才有，
 * 没设就退回公司余额）。问不到就不画（不编一个数）。
 */
function usePickerBalance(): PickerBalance | undefined {
  const { mode } = useMode()
  const wallet = useQuery({
    queryKey: ['cloud-credits', 'chip'],
    queryFn: () => getCloudCredits(),
    retry: false,
  })
  const mine = useQuery({
    queryKey: ['cloud-allocation', 'me', 'picker'],
    queryFn: () => getMyCloudAllocation(),
    retry: false,
    enabled: mode === 'company',
  })
  const limit = mine.data?.mine?.monthly_limit
  if (mode === 'company' && mine.data?.mine !== undefined && limit !== undefined) {
    const used = mine.data.mine.used + mine.data.mine.reserved
    return { kind: 'member_left', credits: Math.max(0, limit - used) }
  }
  const available = wallet.data?.linked === true ? wallet.data.balance?.available : undefined
  return available === undefined ? undefined : { kind: 'balance', credits: available }
}

/**
 * 输入框里用的那一颗：自己取已接的模型、品牌默认与余额；所有者多一项「设为默认」。
 * `value` / `onChange` 是这一次 / 这件事的选择，由调用方存（会话 / 事项上）。
 */
export function ComposerModelPicker({
  value,
  onChange,
  placement = 'up',
  testId,
  effort,
  onEffortChange,
}: {
  value: string | undefined
  onChange: (id: string) => void
  placement?: 'up' | 'down'
  testId?: string
  /** WP370：这一次 / 这件事选的思考程度（调用方存）。 */
  effort?: ReasoningEffort | undefined
  /** WP370：调思考程度（连同当前模型）；不给 = 不出「思考」那一行。 */
  onEffortChange?: ((effort: ReasoningEffort, model: string) => void) | undefined
}): React.ReactNode {
  const client = useQueryClient()
  const models = useQuery({ queryKey: MODEL_CHOICES_KEY, queryFn: getFreeChatModels, retry: false })
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions, retry: false })
  const balance = usePickerBalance()
  const owner = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const makeDefault = useMutation({
    mutationFn: (id: string) => setModelDefaults({ default: id }, owner),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: MODEL_CHOICES_KEY })
      void client.invalidateQueries({ queryKey: ['models'] })
    },
  })
  // 清单回来之前不画（不然会先闪一下「还没接 AI」）
  if (models.data === undefined) return null
  return (
    <ModelPicker
      choices={models.data.choices}
      value={value}
      onChange={onChange}
      defaultId={models.data.default}
      placement={placement}
      rateBase={models.data.rate_base}
      balance={balance}
      effort={effort}
      onEffortChange={onEffortChange}
      {...(owner === undefined
        ? {}
        : {
            onSetDefault: (id: string) => {
              makeDefault.mutate(id)
            },
          })}
      {...(testId === undefined ? {} : { testId })}
    />
  )
}

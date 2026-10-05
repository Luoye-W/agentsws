/**
 * WP126：连接页红人那五张卡上的两块新面板。
 *
 * 1. **数据从哪里来**（每渠道一张四级表的前三级）：顺序可调、每级可停。
 *    第四级（都没有）不是一级，是一句人话 + 两个入口，不在这里画。
 * 2. **自带数据接口（高级）**：服务地址 + 密钥（原生表单 → 本机加密库）+
 *    「测试连接」。不做任何平台预设：界面上不出现任何第三方数据平台的名字，
 *    只给工坊的公开格式（byo/v1）——能照着那份格式回数据的服务都能接。
 *
 * 纪律：只渲染在红人那五张数据卡上（`capabilityOf(service)` 以 `kol.` 开头）；
 * 单价常显交给价目表那一层，这里不写死任何数字。
 *
 * WP139（docs/78 阻断 #2）：两块用两条**自己的**分配发请求，不跟全局当前岗位——
 * 路由表是工作区设置，用连接页传下来的所有者那条；自带数据接口是 `creator.*`，
 * 按「要红人职责」挑自己名下任一条红人职责（`lib/pick-assignment.ts`）。挑不到就说清楚，不发必 403 的请求。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, Hourglass, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import type { DataSourceLevel } from '@/lib/api'
import {
  clearKolByoSource,
  getCapabilitySources,
  getKolByoSources,
  getRedditBrowserReadStatus,
  setCapabilitySources,
  setKolByoSource,
  testKolByoSource,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { KOL_NEED } from '@/lib/pick-assignment'
import { assignmentOf, canRequest, useDutyAssignment } from '@/lib/use-duty-assignment'
import { DutyNeeded } from '../duty-needed'

/** 界面上三级的顺序（默认顺序；用户可在其中调整）。 */
const LEVELS: readonly DataSourceLevel[] = ['official_key', 'byo_source', 'workshop']

/** WP220（Luoye 10-05）：Reddit 取数那一项的键与两路（接口中台 → 浏览器只读）。 */
export const REDDIT_READ_ROUTE_KEY = 'reddit.read'
export const REDDIT_READ_LEVELS: readonly DataSourceLevel[] = ['workshop', 'browser_readonly']

const LEVEL_LABEL_KEYS: Record<DataSourceLevel, string> = {
  official_key: 'data.route.official_key',
  byo_source: 'data.route.byo_source',
  workshop: 'data.route.workshop',
  // WP179：只属于网页搜索那一项（红人渠道的表里不会出现），开关在模型页
  deepseek_native: 'web.search.title',
  // WP220：只属于 Reddit 取数那一项
  browser_readonly: 'data.route.browser_readonly',
}

/** 当前生效的顺序（没配过的渠道用默认）。 */
function effectiveOrder(
  routing: Record<string, { order: DataSourceLevel[]; disabled: DataSourceLevel[] }> | undefined,
  capability: string,
  levels: readonly DataSourceLevel[] = LEVELS,
): { order: DataSourceLevel[]; disabled: DataSourceLevel[] } {
  const saved = routing?.[capability]
  if (saved === undefined || saved.order.length === 0) return { order: [...levels], disabled: [] }
  // 只认这一项自己的几级、无重复的顺序；坏了就回默认（设置文件是手改不过来的，但防一手）
  const order = saved.order.filter((l, i) => levels.includes(l) && saved.order.indexOf(l) === i)
  const missing = levels.filter((l) => !order.includes(l))
  return {
    order: [...order, ...missing],
    disabled: saved.disabled.filter((l) => levels.includes(l)),
  }
}

export function DataSourceRouteControl({
  channel,
  assignment,
  routeKey,
  levels = LEVELS,
  note,
}: {
  channel: string
  /** 所有者那条（工作区设置）；没传 = 全局当前岗位 */
  assignment?: string | undefined
  /** WP220：路由键（不给 = 红人那条 `kol.<渠道>`；Reddit 卡给 `reddit.read`） */
  routeKey?: string
  /** WP220：这一项认哪几级（默认红人那三级） */
  levels?: readonly DataSourceLevel[]
  /** WP220：表下面那一句（i18n 键） */
  note?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const capability = routeKey ?? `kol.${channel}`
  const sources = useQuery({
    queryKey: ['capability-sources', assignment],
    queryFn: () => getCapabilitySources(assignment),
    retry: false,
  })

  const save = useMutation({
    mutationFn: (next: { order: DataSourceLevel[]; disabled: DataSourceLevel[] }) =>
      setCapabilitySources(sources.data?.capability_sources ?? {}, assignment, {
        [capability]: next,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['capability-sources'] }),
  })

  const current = effectiveOrder(sources.data?.data_source_routing, capability, levels)

  const move = (level: DataSourceLevel, delta: -1 | 1): void => {
    const order = [...current.order]
    const i = order.indexOf(level)
    const j = i + delta
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j] as DataSourceLevel, order[i] as DataSourceLevel]
    save.mutate({ order, disabled: current.disabled })
  }
  const toggle = (level: DataSourceLevel): void => {
    const disabled = current.disabled.includes(level)
      ? current.disabled.filter((l) => l !== level)
      : [...current.disabled, level]
    save.mutate({ order: current.order, disabled })
  }

  if (sources.isLoading) return null

  return (
    <div className="flex flex-col gap-1" data-testid="data-source-route" data-channel={channel}>
      <p className="text-xs font-medium" data-slot="title">
        {t('data.route.title')}
      </p>
      {current.order.map((level, i) => {
        const disabled = current.disabled.includes(level)
        return (
          <div key={level} className="flex items-center gap-1 text-xs">
            <span className={disabled ? 'text-muted-foreground line-through' : ''}>
              {i + 1}. {t(LEVEL_LABEL_KEYS[level])}
            </span>
            {level === 'browser_readonly' && !disabled ? (
              <ReadonlyBrowserBadge assignment={assignment} />
            ) : null}
            <span className="flex-1" />
            <Button
              size="xs"
              variant="ghost"
              aria-label={t('data.route.up')}
              disabled={i === 0 || save.isPending}
              onClick={() => move(level, -1)}
            >
              ↑
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-label={t('data.route.down')}
              disabled={i === current.order.length - 1 || save.isPending}
              onClick={() => move(level, 1)}
            >
              ↓
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => toggle(level)}
            >
              {disabled ? t('data.route.enable') : t('data.route.disable')}
            </Button>
          </div>
        )
      })}
      {note === undefined ? null : <p className="text-[11px] text-muted-foreground">{t(note)}</p>}
      {save.error === null || save.error === undefined ? null : (
        <p className="text-[11px] text-destructive">{save.error.message}</p>
      )}
    </div>
  )
}

const RO_ICON = {
  ready: <CircleCheck className="size-3.5 text-primary" aria-hidden />,
  no_browser: <CircleAlert className="size-3.5 text-muted-foreground" aria-hidden />,
  quota_used_up: <Hourglass className="size-3.5 text-muted-foreground" aria-hidden />,
  blocked: <ShieldAlert className="size-3.5 text-destructive" aria-hidden />,
} as const

/**
 * WP228：「浏览器只读」那一路现在能不能用（本机只读浏览器）——图标 + 两三个字，原话进问号（36 §7）。
 * 服务进程没装这一面（演示 / 托管）就什么都不画。
 */
export function ReadonlyBrowserBadge({
  assignment,
}: {
  assignment?: string | undefined
}): React.ReactNode {
  const { t } = useApp()
  const status = useQuery({
    queryKey: ['reddit-browser-read-status', assignment],
    queryFn: () => getRedditBrowserReadStatus(assignment),
    retry: false,
    refetchInterval: 60_000,
  })
  const s = status.data
  if (s === undefined) return null
  const hint =
    s.state === 'ready'
      ? t('data.route.ro.ready_hint', {
          browser: s.browser ?? 'Chrome',
          used: s.pages_last_day,
          max: s.max_pages_per_day,
        })
      : s.until === undefined
        ? (s.message ?? '')
        : `${s.message ?? ''}${t('data.route.ro.until', {
            time: new Date(s.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          })}`
  return (
    <span
      className="flex items-center gap-1 text-[11px] text-muted-foreground"
      data-testid="readonly-browser-status"
      data-state={s.state}
    >
      {RO_ICON[s.state]}
      {t(`data.route.ro.${s.state}`)}
      {hint === '' ? null : <Hint text={hint} />}
    </span>
  )
}

export function ByoSourceCard({ channel }: { channel: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [result, setResult] = useState<string | undefined>(undefined)
  const pick = useDutyAssignment(KOL_NEED)
  const asg = assignmentOf(pick)

  const list = useQuery({
    queryKey: ['kol-byo-sources', asg],
    enabled: canRequest(pick),
    queryFn: () => getKolByoSources(asg),
    retry: false,
  })
  const existing = list.data?.rows.find((r) => r.channel === channel)

  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['kol-byo-sources'] })
  }

  const save = useMutation({
    mutationFn: () =>
      setKolByoSource(
        {
          channel,
          service_url: url,
          ...(key === '' ? {} : { api_key: key }),
        },
        asg,
      ),
    onSuccess: () => {
      invalidate()
      setKey('')
      setResult(t('data.byo.saved'))
    },
    onError: (e) => setResult(apiErrorText(e, t)),
  })

  const test = useMutation({
    mutationFn: () =>
      testKolByoSource(
        {
          channel,
          ...(url === '' ? {} : { service_url: url }),
          ...(key === '' ? {} : { api_key: key }),
        },
        asg,
      ),
    onSuccess: (r) => setResult(r.message),
    onError: (e) => setResult(apiErrorText(e, t)),
  })

  const remove = useMutation({
    mutationFn: () => clearKolByoSource(channel, asg),
    onSuccess: () => {
      invalidate()
      setUrl('')
      setKey('')
      setResult(undefined)
    },
  })

  const busy = save.isPending || test.isPending || remove.isPending

  if (pick.kind === 'none' || pick.kind === 'no_range')
    return (
      <div className="flex flex-col gap-1.5" data-testid="byo-source" data-channel={channel}>
        <p className="text-xs font-medium" data-slot="title">
          {t('data.byo.title')}
        </p>
        <DutyNeeded need={KOL_NEED} kind={pick.kind} testid="byo-duty-needed" compact />
      </div>
    )

  return (
    <div className="flex flex-col gap-1.5" data-testid="byo-source" data-channel={channel}>
      {/* WP157：合规那句与返回格式进问号（填之前 hover 一下就看得到） */}
      <p className="flex items-center gap-1 text-xs font-medium" data-slot="title">
        {t('data.byo.title')}
        <Hint text={`${t('data.byo.compliance')} ${t('data.byo.format')}`} testId="byo-hint" />
      </p>
      {list.error === null ? null : (
        <p role="alert" className="text-[11px] text-destructive" data-testid="byo-source-error">
          {apiErrorText(list.error, t)}
        </p>
      )}
      <Input
        value={existing === undefined ? url : url === '' ? existing.service_url : url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t('data.byo.url')}
        className="h-8 text-xs"
        aria-label={t('data.byo.url')}
      />
      <Input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={existing?.has_key === true ? t('data.byo.key.set') : t('data.byo.key')}
        className="h-8 text-xs"
        aria-label={t('data.byo.key')}
        autoComplete="off"
      />
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" disabled={busy} onClick={() => save.mutate()}>
          {t('data.byo.save')}
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => test.mutate()}>
          {t('data.byo.test')}
        </Button>
        {existing !== undefined ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => remove.mutate()}>
            {t('data.byo.remove')}
          </Button>
        ) : null}
      </div>
      {result === undefined ? null : (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="byo-source-result"
          data-slot="status"
        >
          {result}
        </p>
      )}
    </div>
  )
}

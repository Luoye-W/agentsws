/**
 * WP241 岗位页「设置」页签（`position-v2-settings.html`）：平时不用看的都在这。
 *
 * 五节，按「多久动一次」排：职责 · 连接 · 记忆 · 定时任务 · 高级（默认折叠）。
 * 每一节都是把原来散在页上的东西挪过来，组件原样复用：
 * - 职责：原来折在「交给它」底下；加减 / 合并 / 移动 / 拆出的入口落到公司页岗位卡（只有负责人能改）；
 * - 连接：原来页顶「连上这 N 个就能开工」大卡 → 必需 / 可选分开，**可选收成一行**（#72）；
 *   取数已由接口中台满足的写「不用连」（WP238 `missing_required` 口径）；建站平台的 CLI 卡也在这；
 * - 记忆：原来的「记忆」页签（岗位一层 + 每条职责一层，`LayerMemory`）；
 * - 定时任务：原来压在「记录」底下，**本人在这个岗位每条职责上的**都列出来，一个开关停 / 开；
 * - 高级：WP238 的人话权限（`lib/duty-capabilities`），原始 id 只在「开发者视图」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ExternalLink, MoreHorizontal, Plus, Split } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { PlatformCliCard } from '@/components/connections/platform-cli-card'
import { InfoTip } from '@/components/design'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { triggerText } from '@/components/schedule-list'
import { Hint } from '@/components/ui/hint'
import { PlannedTag } from '@/components/ui/planned-tag'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { LayerMemory } from '@/components/work/layer-memory'
import {
  getPositionConnections,
  getRoleDefinition,
  getSchedules,
  type PositionConnectionItem,
  type PositionInstanceData,
  patchSchedule,
  type ScheduledTaskRow,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { actionLines, connectorLines, scopeLines, skillLines } from '@/lib/duty-capabilities'
import { formatDate } from '@/lib/format'
import { Pop } from './work-bits'

/** 职责说明里的 `**粗体**` 记号在一行小字里不认，去掉星号（整段在职责页）。 */
const plain = (text: string | undefined): string => (text ?? '').replace(/\*\*/g, '')

const SECTIONS = ['duties', 'connections', 'memory', 'schedules', 'advanced'] as const

function SectionHead({ id, title, sub }: { id: string; title: string; sub?: string }): ReactNode {
  return (
    <h3 className="mb-2 flex flex-wrap items-baseline gap-2" id={`pos-set-${id}`}>
      <span className="ws-display text-[16px]">{title}</span>
      {sub === undefined ? null : <span className="text-xs text-ws-muted-fg">{sub}</span>}
    </h3>
  )
}

function DutyLine({
  role,
  assignment,
}: {
  role: PositionInstanceData['roles'][number]
  assignment: string
}): ReactNode {
  const { t } = useApp()
  const def = useQuery({
    queryKey: ['role-definition', role.role_id],
    queryFn: () => getRoleDefinition(role.role_id),
  })
  const mine = role.my_assignment_id
  return (
    <li
      className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
      data-testid="settings-duty"
      data-role={role.role_id}
    >
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-ws-surface">
        <DutyIcon role_id={role.role_id} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {role.role_name}
          {role.planned === true ? <PlannedTag /> : null}
          {mine === undefined ? (
            <span className="text-xs font-normal text-ws-muted-fg">
              {t('pos2.set.duty.not_mine')}
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-ws-muted-fg" title={plain(def.data?.description)}>
          {plain(def.data?.description)}
        </p>
      </div>
      {mine === undefined ? null : (
        <Link
          to={`/positions/${encodeURIComponent(mine)}/duties/${encodeURIComponent(role.role_id)}`}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent"
          data-testid="settings-duty-open"
        >
          {t('pos2.set.duty.open')}
        </Link>
      )}
      <Pop
        label=""
        icon={<MoreHorizontal className="size-4" aria-label={t('pos2.set.duty.more')} />}
        testId="settings-duty-menu"
      >
        <Link
          to="/org?tab=positions"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent"
          data-testid="settings-duty-reshape"
          data-assignment={assignment}
        >
          <Split className="size-3.5" aria-hidden />
          {t('pos2.set.duty.reshape')}
        </Link>
      </Pop>
    </li>
  )
}

function ConnectionRow({
  item,
  satisfied,
}: {
  item: PositionConnectionItem
  satisfied: boolean
}): ReactNode {
  const { t, lang } = useApp()
  const name = lang === 'en' ? item.name.en : item.name.zh
  const right = item.connected ? (
    <span className="text-xs text-ws-good" data-slot="status">
      {t('pos2.set.conn.ok')}
    </span>
  ) : satisfied ? null : item.status === 'available' && item.connect_service !== undefined ? (
    <Link
      to={`/connections?service=${encodeURIComponent(item.connect_service)}`}
      className="inline-flex h-7 items-center rounded-md border px-2 text-xs hover:bg-accent"
      data-testid="settings-connection-go"
    >
      {t('pos2.set.conn.go')}
    </Link>
  ) : (
    <span className="text-xs text-ws-muted-fg" data-slot="status">
      {t('pos2.set.conn.planned')}
    </span>
  )
  return (
    <li
      className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
      data-testid="settings-connection"
      data-kind={item.kind}
      data-required={item.required ? 'true' : 'false'}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm">{name}</p>
        <p className="truncate text-xs text-ws-muted-fg">
          {satisfied
            ? t('pos2.set.conn.via')
            : t('pos2.set.conn.for', { roles: item.needed_by.join('、') })}
        </p>
      </div>
      {right}
    </li>
  )
}

function Connections({ id, positionId }: { id: string; positionId: string }): ReactNode {
  const { t } = useApp()
  const [more, setMore] = useState(false)
  const view = useQuery({
    queryKey: ['position-connections', id],
    queryFn: () => getPositionConnections(id),
    enabled: id !== '',
  })
  if (view.isPending) return <Skeleton className="h-24 w-full" />
  const items = view.data?.items ?? []
  const missing = new Set(view.data?.missing_required ?? [])
  const required = items.filter((i) => i.required)
  const optional = items.filter((i) => !i.required)
  // 必需、没连、但服务端没把它算进「真缺」= 取数已由别的路满足（WP238）
  const satisfied = (i: PositionConnectionItem): boolean =>
    i.required && !i.connected && !missing.has(i.kind)
  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pos2.set.conn.none')}</p>
      ) : (
        <div
          className="overflow-hidden rounded-xl border bg-card"
          data-testid="settings-connections"
        >
          {required.length === 0 ? null : (
            <>
              <p className="px-4 pt-2.5 text-[11px] text-ws-muted-fg">
                {t('pos2.set.conn.required')}
              </p>
              <ul>
                {required.map((i) => (
                  <ConnectionRow key={i.kind} item={i} satisfied={satisfied(i)} />
                ))}
              </ul>
            </>
          )}
          {optional.length === 0 ? null : (
            <div className={required.length === 0 ? '' : 'border-t'}>
              {/* #72（Luoye 10-06）：可选收成一行「还有 N 个可选」，点开才展开 */}
              <button
                type="button"
                aria-expanded={more}
                data-testid="settings-connections-more"
                className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-xs text-ws-muted-fg hover:bg-accent"
                onClick={() => {
                  setMore(!more)
                }}
              >
                {more ? (
                  <ChevronDown className="size-3.5" aria-hidden />
                ) : (
                  <ChevronRight className="size-3.5" aria-hidden />
                )}
                {more ? t('pos2.set.conn.less') : t('pos2.set.conn.more', { n: optional.length })}
              </button>
              {more ? (
                <ul className="border-t">
                  {optional.map((i) => (
                    <ConnectionRow key={i.kind} item={i} satisfied={false} />
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>
      )}
      {/* WP216：建站平台的官方 CLI 卡（只在平台那一行写的岗位上出） */}
      <PlatformCliCard positionId={positionId} assignment={id} />
    </div>
  )
}

function ScheduleRows({ assignments }: { assignments: readonly string[] }): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const lists = useQuery({
    queryKey: ['schedules', 'position', assignments.join(',')],
    queryFn: async () => {
      const parts = await Promise.all(
        assignments.map(async (a) =>
          (await getSchedules(a)).map((row) => ({ row, assignment: a })),
        ),
      )
      const seen = new Set<string>()
      return parts.flat().filter((x) => {
        if (seen.has(x.row.id)) return false
        seen.add(x.row.id)
        return true
      })
    },
  })
  const toggle = useMutation({
    mutationFn: (input: { row: ScheduledTaskRow; assignment: string }) =>
      patchSchedule(
        input.row.id,
        { action: input.row.state === 'paused' ? 'resume' : 'pause' },
        input.assignment,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['schedules'] })
      void client.invalidateQueries({ queryKey: ['position-work'] })
    },
  })
  if (lists.isPending) return <Skeleton className="h-20 w-full" />
  const rows = (lists.data ?? []).filter((x) => x.row.state !== 'cancelled')
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">{t('pos2.set.schedules.empty')}</p>
  return (
    <ul className="overflow-hidden rounded-xl border bg-card" data-testid="settings-schedules">
      {rows.map(({ row, assignment }) => {
        const paused = row.state === 'paused'
        return (
          <li
            key={row.id}
            data-testid="schedule-row"
            data-state={row.state}
            className={`flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0 ${paused ? 'opacity-70' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{row.title ?? row.handler ?? row.id}</p>
              <p className="text-xs text-ws-muted-fg">
                {triggerText(row.trigger, lang)}
                {paused
                  ? ` · ${t('pos2.set.schedules.paused')}`
                  : row.next_fire_at === undefined
                    ? ''
                    : ` · ${t('pos2.set.schedules.next', { at: formatDate(row.next_fire_at, lang) })}`}
              </p>
            </div>
            <Switch
              checked={!paused}
              disabled={toggle.isPending}
              aria-label={paused ? t('pos2.set.schedules.off') : t('pos2.set.schedules.on')}
              data-testid="schedule-switch"
              onCheckedChange={() => {
                toggle.mutate({ row, assignment })
              }}
            />
          </li>
        )
      })}
    </ul>
  )
}

function DutyCapabilities({
  role_id,
  name,
  dev,
}: {
  role_id: string
  name: string
  dev: boolean
}): ReactNode {
  const { t, lang } = useApp()
  const def = useQuery({
    queryKey: ['role-definition', role_id],
    queryFn: () => getRoleDefinition(role_id),
  })
  if (def.data === undefined) return def.isPending ? <Skeleton className="h-10 w-full" /> : null
  const lines = [
    ...scopeLines(def.data, t),
    ...actionLines(def.data, t),
    ...skillLines(def.data, t),
    ...connectorLines(def.data, t, lang),
  ]
  return (
    <div className="flex flex-col gap-1.5" data-testid="settings-capabilities" data-role={role_id}>
      <h5 className="flex items-center gap-1.5 text-xs font-medium">
        <DutyIcon role_id={role_id} size={14} />
        {t('pos2.set.advanced.can', { name })}
      </h5>
      <ul className="flex flex-wrap gap-1.5">
        {lines.map((l) => (
          <li
            key={l.key}
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs"
            data-raw={l.raw}
          >
            <InfoTip text={l.raw}>{l.text}</InfoTip>
            {dev ? (
              <code className="text-[10.5px] text-ws-muted-fg" data-testid="settings-raw-id">
                {l.raw}
              </code>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Advanced({ roles }: { roles: PositionInstanceData['roles'] }): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const [dev, setDev] = useState(false)
  return (
    <div className="rounded-xl border bg-card" data-testid="settings-advanced">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          data-testid="settings-advanced-toggle"
          className="flex flex-1 items-center gap-1.5 text-left"
          onClick={() => {
            setOpen(!open)
          }}
        >
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          <span className="text-sm font-medium" id="pos-set-advanced">
            {t('pos2.set.advanced')}
          </span>
          <span className="text-xs text-ws-muted-fg">{t('pos2.set.advanced.sub')}</span>
        </button>
        <span className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
          {t('pos2.set.advanced.dev')}
          <Switch
            checked={dev}
            data-testid="settings-dev-toggle"
            aria-label={t('pos2.set.advanced.dev')}
            onCheckedChange={(v) => {
              setDev(v)
              if (v) setOpen(true)
            }}
          />
        </span>
      </div>
      {open ? (
        <div
          className="flex flex-col gap-4 border-t px-4 py-3"
          data-testid="settings-advanced-body"
        >
          {roles.map((r) => (
            <DutyCapabilities key={r.role_id} role_id={r.role_id} name={r.role_name} dev={dev} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function PositionSettings({
  id,
  view,
}: {
  id: string
  view: PositionInstanceData | undefined
}): ReactNode {
  const { t } = useApp()
  if (view === undefined) return <Skeleton className="h-64 w-full" />
  const mine = view.roles.flatMap((r) =>
    r.my_assignment_id === undefined ? [] : [r.my_assignment_id],
  )
  const assignments = mine.length === 0 ? [id] : mine
  return (
    <div className="grid gap-6 lg:grid-cols-[9.5rem_minmax(0,1fr)]" data-testid="position-settings">
      <nav className="hidden lg:block" aria-label={t('pos2.set.nav')}>
        <ul className="sticky top-4 flex flex-col gap-0.5 text-sm">
          {SECTIONS.map((s) => (
            <li key={s}>
              <a
                href={`#pos-set-${s}`}
                className="block rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById(`pos-set-${s}`)?.scrollIntoView?.({ behavior: 'smooth' })
                }}
              >
                {t(`pos2.set.${s}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-col gap-7">
        <section data-testid="settings-duties">
          <SectionHead
            id="duties"
            title={t('pos2.set.duties')}
            sub={t('pos2.set.duties.sub', { n: view.roles.length })}
          />
          <div className="overflow-hidden rounded-xl border bg-card">
            <ul>
              {view.roles.map((r) => (
                <DutyLine key={r.role_id} role={r} assignment={r.my_assignment_id ?? id} />
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
              <Link
                to="/org?tab=positions"
                className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent"
                data-testid="settings-duty-add"
              >
                <Plus className="size-3.5" aria-hidden />
                {t('pos2.set.duty.add')}
              </Link>
              <Link
                to="/org?tab=positions"
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-accent"
                data-testid="settings-duty-merge"
              >
                <ExternalLink className="size-3.5" aria-hidden />
                {t('pos2.set.duty.merge')}
              </Link>
              <Hint text={t('pos2.set.duty.reshape.hint')} />
            </div>
          </div>
        </section>

        <section>
          <SectionHead
            id="connections"
            title={t('pos2.set.connections')}
            sub={t('pos2.set.connections.sub')}
          />
          <Connections id={id} positionId={view.position_id} />
        </section>

        <section data-testid="position-memory">
          <SectionHead id="memory" title={t('pos2.set.memory')} sub={t('pos2.set.memory.sub')} />
          <div className="flex flex-col gap-4">
            <div>
              <h4 className="mb-1.5 text-sm font-medium">
                {t('memory.position', { name: view.name.zh })}
              </h4>
              <LayerMemory tier="position" scopeId={view.position_id} />
            </div>
            {view.roles.map((r) => (
              <div key={r.role_id} data-testid="role-memory" data-role={r.role_id}>
                <h4 className="mb-1.5 text-sm font-medium">
                  {t('memory.role', { name: r.role_name })}
                </h4>
                <LayerMemory tier="role" scopeId={r.role_id} />
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHead
            id="schedules"
            title={t('pos2.set.schedules')}
            sub={t('pos2.set.schedules.sub')}
          />
          <ScheduleRows assignments={assignments} />
        </section>

        <section>
          <Advanced roles={view.roles} />
        </section>
      </div>
    </div>
  )
}

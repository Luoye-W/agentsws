/**
 * WP71（36 §10）**职责页**：`/positions/:assignment/duties/:role_id`。
 *
 * 只从两处进得来——左栏岗位展开层，或岗位页的职责折叠层。**首页上没有它**：
 * 职责太细，放在首页只会让人每天多读四行（54 §4 定的"开启任务主要在岗位里"）。
 *
 * 页面很薄，故意的：
 *
 * - 头部：面包屑「岗位 › 职责」、职责名、版本、"内置只读 / 从内置模板复制"pill、
 *   谁在做、范围，以及**「用这条职责开一件事」**（走 WP69 的 `entry: 'role'`）；
 * - 两个 tab：**概览**（这条职责能看什么、能做什么、挂着哪些技能与连接器）与
 *   **记录**（它做过什么）。
 *
 * **记忆 / 技能 / 知识 / 额度不在这一页上**——它们是第三栏的四个面板（36 §9），
 * 跟着当前职责走。进了这一页，右栏打开的就是这条职责那一份。头部那四个按钮
 * 只是"把右栏打开到那一格"的快捷方式，不是第二个入口。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CalendarLink } from '@/components/calendar/calendar-link'
import { PanelError } from '@/components/rail/panel-error'
import { useRailState } from '@/components/rail/rail-state'
// WP73（56 §6）：社媒运营九条渠道职责的内容日历（周视图）与群发向导
import { SocialBroadcast } from '@/components/social/social-broadcast'
import { SocialCalendar, socialChannelOfRole } from '@/components/social/social-calendar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ApiClientError,
  createMatterWithRole,
  getPosition,
  getPositionRecords,
  getRoleDefinition,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'

/** 头部那一行「用这条职责开一件事」：54 §2 保留的从职责开启那条路。 */
function OpenHere({ assignment }: { assignment: string }): React.ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const open = useMutation({
    // 54 §2 职责入口：用**这条职责的分配**建事项，跳过岗位内路由——
    // 权限、额度、动作面全是这一条的（不是岗位的并集）
    mutationFn: (text: string) => createMatterWithRole(assignment, { title: text }),
    onSuccess: (out) => {
      setTitle('')
      setError(null)
      navigate(`/matters/${out.matter.id}`)
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })
  return (
    <div className="flex flex-col gap-1" data-testid="duty-open">
      <div className="flex gap-2">
        <Input
          value={title}
          aria-label={t('duty.open')}
          placeholder={t('duty.open.placeholder')}
          data-testid="duty-open-text"
          onChange={(e) => {
            setTitle(e.target.value)
          }}
        />
        <Button
          size="sm"
          data-testid="duty-open-submit"
          disabled={title.trim() === '' || open.isPending}
          onClick={() => {
            open.mutate(title.trim())
          }}
        >
          <Play aria-hidden className="size-3.5" />
          {t('duty.open')}
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive" data-testid="duty-open-error">
          {error}
        </p>
      )}
    </div>
  )
}

function OverviewTab({ role_id }: { role_id: string }): React.ReactNode {
  const { t } = useApp()
  const role = useQuery({
    queryKey: ['role-definition', role_id],
    queryFn: () => getRoleDefinition(role_id),
  })
  if (role.isPending) return <Skeleton className="h-48 w-full" />
  if (role.error !== null || role.data === undefined) return <PanelError error={role.error} />
  const view = role.data
  return (
    <div className="flex flex-col gap-4" data-testid="duty-overview">
      <p className="text-sm text-muted-foreground">{view.description}</p>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('duty.scopes')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {view.scopes.map((s) => (
            <div key={`${s.domain}:${s.range}`} data-testid="duty-scope">
              <span className="font-medium">{s.domain}</span>
              <span className="text-muted-foreground">
                {' · '}
                {s.ops.join(' / ')} · {s.range} · {s.max_sensitivity}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('duty.actions')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {view.actions.length === 0 ? (
            <p className="text-muted-foreground">{t('duty.actions.none')}</p>
          ) : (
            view.actions.map((a) => (
              <div key={a.id} data-testid="duty-action">
                <span className="font-medium">{a.id}</span>
                <span className="text-muted-foreground">
                  {' · '}
                  {a.kind} → {a.target}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('duty.skills')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {view.skills.map((s) => (
            <div key={s.name} data-testid="duty-skill">
              <span>{s.name}</span>
              <span className="text-muted-foreground">
                {' · '}
                {s.tier} · {s.load}
              </span>
            </div>
          ))}
          {view.connectors.length === 0 ? null : (
            <p className="text-xs text-muted-foreground" data-testid="duty-connectors">
              {t('duty.connectors', { list: view.connectors.map((c) => c.kind).join(' · ') })}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function RecordsTab({ assignment }: { assignment: string }): React.ReactNode {
  const { t, lang } = useApp()
  const records = useQuery({
    queryKey: ['records', assignment],
    queryFn: () => getPositionRecords(assignment),
  })
  if (records.isPending) return <Skeleton className="h-40 w-full" />
  const rows = records.data?.payload?.rows ?? []
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">—</p>
  return (
    <ol className="flex flex-col gap-3" data-testid="duty-records">
      {rows.map((row) => (
        <li key={row.id} className="border-l pl-3">
          <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
            <time dateTime={row.at}>{formatDate(row.at, lang)}</time>
            <span>{t(`kind.${row.kind}`)}</span>
            <span className="font-mono">{row.state}</span>
          </div>
          <div className="text-sm">{row.title}</div>
          <p className="text-xs text-muted-foreground">{row.summary}</p>
        </li>
      ))}
    </ol>
  )
}

/** 社群组五条（56 §0）。真源是契约的 `SOCIAL_CHANNELS[].group`，这里照抄一份。 */
const COMMUNITY_CHANNELS: string[] = [
  'facebook_group',
  'reddit',
  'discord',
  'telegram_group',
  'whatsapp',
]

export function DutyPage(): React.ReactNode {
  const { t, lang, selectPosition, position } = useApp()
  const params = useParams<{ assignment: string; role_id: string }>()
  const assignment = params.assignment ?? ''
  const role_id = params.role_id ?? ''
  const [tab, setTab] = useState('overview')

  /*
   * 进职责页 = 把当前 Assignment 切到**这一条职责**（31 §3.1 一次请求一个 Assignment）。
   *
   * 与岗位页那条规矩（WP70：当前分配跟着岗位走、不被顶回第一条）不冲突——
   * 那一条说的是"点左栏岗位行不要动职责"，这一页是人**明确点了这条职责**。
   */
  useEffect(() => {
    if (assignment !== '' && assignment !== position) selectPosition(assignment)
  }, [assignment, position, selectPosition])

  const owner = useQuery({
    queryKey: ['position-instance', assignment],
    enabled: assignment !== '',
    queryFn: () => getPosition(assignment),
  })
  const role = useQuery({
    queryKey: ['role-definition', role_id],
    enabled: role_id !== '',
    queryFn: () => getRoleDefinition(role_id),
  })

  const instance = owner.data
  const here = instance?.roles.find((r) => r.role_id === role_id)
  const positionName =
    instance === undefined ? '' : lang === 'en' ? instance.name.en : instance.name.zh
  /** 这条职责是不是九条社媒渠道之一（`social.facebook-group` → `facebook_group`）。 */
  const socialChannel = socialChannelOfRole(role_id)

  /** 头部四个按钮 = 把第三栏打开到那一格。第三栏自己会认出这一页是职责层。 */
  const rail = useRailState()

  return (
    <div className="flex flex-col gap-4" data-testid="duty-page" data-duty={role_id}>
      <nav
        className="flex items-center gap-1 text-xs text-muted-foreground"
        aria-label="breadcrumb"
      >
        <Link to={`/positions/${encodeURIComponent(assignment)}`} data-testid="duty-breadcrumb">
          {positionName === '' ? t('nav.positions') : positionName}
        </Link>
        <span aria-hidden>›</span>
        <span>{here?.role_name ?? role_id}</span>
      </nav>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-lg font-semibold" data-testid="duty-name">
            {role.data?.name ?? here?.role_name ?? role_id}
          </h1>
          {role.data === undefined ? null : (
            <>
              <span className="font-mono text-xs text-muted-foreground">v{role.data.version}</span>
              <span
                className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                data-testid="duty-source"
              >
                {role.data.source === 'bundled' ? t('duty.bundled') : t('duty.custom')}
              </span>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="duty-holders">
          {t('duty.holders', { count: role.data?.holders ?? 0 })}
        </p>
        <OpenHere assignment={assignment} />
        {/* 四个设置面板在右栏（36 §9）；这一行只是把右栏打开到那一格 */}
        <div className="flex flex-wrap items-center gap-1" data-testid="duty-rail-links">
          {['memory', 'skills', 'knowledge', 'caps'].map((panel) => (
            <Button
              key={panel}
              size="xs"
              variant="outline"
              data-testid={`duty-open-${panel}`}
              onClick={() => {
                rail.show(panel)
              }}
            >
              {t(`rail.panel.${panel}`)}
            </Button>
          ))}
          {/* WP74：进去的是同一个日历，只是默认开着与这条职责相关的那几层 */}
          <CalendarLink role_id={role_id} />
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">{t('duty.tab.overview')}</TabsTrigger>
          <TabsTrigger value="records">{t('duty.tab.records')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          {/*
            WP73（56 §6）：社媒那九条渠道职责的职责页上多两块**能动手的**——
            内容日历（周视图，拖得动）与群发向导。排在概览之前，与红人那一块
            同一个道理：这条职责的产出不在"它是什么"里，在"这周发什么、发给谁"上。
            群发向导只给社群组五条（56 §0 的两组分法）——内容组四条上没有
            "群里的人"这回事，画一个点不动的向导比不画更糟。
          */}
          {socialChannel === undefined ? null : (
            <div className="mb-4 flex flex-col gap-4">
              <SocialCalendar assignment={assignment} channel={socialChannel} />
              {COMMUNITY_CHANNELS.includes(socialChannel) ? (
                <SocialBroadcast assignment={assignment} channel={socialChannel} />
              ) : null}
            </div>
          )}
          <OverviewTab role_id={role_id} />
        </TabsContent>
        <TabsContent value="records">
          <RecordsTab assignment={assignment} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

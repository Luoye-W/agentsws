/**
 * 设置 →「官方插件」（WP180）。
 *
 * DeepSeek 官方的可选插件，只列我们审过的那几个。每一行：名字（说明进问号）、状态、一个按钮。
 * 点装 / 升级 / 卸载**不直接做**——出一张卡到牌堆里，批了才做（卡上写版本、来源、许可证、工具、出不出网）。
 * 少字（36 §7）：说明、许可证、工具清单都进问号；卡面上只有"出网"这一项必须一眼看见（安全相关）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpCircle,
  Download,
  Globe,
  Hourglass,
  Loader2,
  type LucideIcon,
  Puzzle,
} from 'lucide-react'
import { useState } from 'react'
import { StatusIcons, type StatusState } from '@/components/design'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint, SafetyNote } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  getOfficialPlugins,
  type OfficialPluginAction,
  type OfficialPluginView,
  requestOfficialPluginChange,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** WP214：插件状态 → 四态（颜色 + 角标形状）。 */
const PLUGIN_STATE: Record<OfficialPluginView['state'], StatusState> = {
  installed: 'ok',
  upgradable: 'ok',
  available: 'unknown',
  pending: 'pending',
  unreviewed: 'pending',
}

/** 每种状态一个图标：装着 = 拼图、有新版 = 向上箭头、没装 = 下载、等批 / 待审 = 沙漏。 */
const PLUGIN_ICON: Record<OfficialPluginView['state'], LucideIcon> = {
  installed: Puzzle,
  upgradable: ArrowUpCircle,
  available: Download,
  pending: Hourglass,
  unreviewed: Hourglass,
}

/** 这一行的按钮做什么（没有按钮 = `undefined`）。 */
function actionOf(p: OfficialPluginView): OfficialPluginAction | undefined {
  if (p.state === 'available') return 'install'
  if (p.state === 'upgradable') return 'upgrade'
  if (p.state === 'installed') return 'uninstall'
  return undefined
}

function hintOf(p: OfficialPluginView, t: ReturnType<typeof useApp>['t']): string {
  const tools = p.tools.length === 0 ? t('plugins.tools.none') : p.tools.join('、')
  return [
    p.summary,
    t('plugins.hint.meta', { version: p.version, license: p.license }),
    t('plugins.hint.tools', { tools }),
    p.network ? (p.network_note ?? '') : t('plugins.hint.offline'),
  ]
    .filter((x) => x !== '')
    .join('\n')
}

function Row({
  plugin,
  busy,
  onAct,
}: {
  plugin: OfficialPluginView
  busy: boolean
  onAct: (action: OfficialPluginAction) => void
}): React.ReactNode {
  const { t } = useApp()
  const action = actionOf(plugin)
  return (
    <li
      className="flex items-center justify-between gap-3 rounded-md border p-2.5"
      data-testid={`plugin-${plugin.name}`}
      data-state={plugin.state}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium">{plugin.title}</span>
        <Hint text={hintOf(plugin, t)} />
        {plugin.network ? (
          <Badge variant="outline" data-testid="plugin-network">
            <Globe aria-hidden />
            {t('plugins.network')}
          </Badge>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/*
          WP214（36 §7 第四档）：状态一个小图标（已装 = 通、没装 = 没测、等批 / 待审 = 进行中），
          状态词与版本进 tooltip；按钮上的字（装 / 升级 / 卸载）已经说了下一步。
        */}
        <StatusIcons
          testId="plugin-state"
          label={t(`plugins.state.${plugin.state}`)}
          items={[
            {
              key: plugin.state,
              label: plugin.title,
              state: PLUGIN_STATE[plugin.state],
              stateText: t(`plugins.state.${plugin.state}`),
              icon: PLUGIN_ICON[plugin.state],
              ...(plugin.installed_version === undefined
                ? {}
                : {
                    detail: t('plugins.installed_version', { version: plugin.installed_version }),
                  }),
            },
          ]}
        />
        {action === undefined ? null : (
          <Button
            size="sm"
            variant={action === 'uninstall' ? 'outline' : 'default'}
            disabled={busy}
            data-testid="plugin-action"
            onClick={() => {
              onAct(action)
            }}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {t(`plugins.action.${action}`)}
          </Button>
        )}
      </div>
    </li>
  )
}

export function OfficialPluginsPanel({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [error, setError] = useState<string | undefined>(undefined)
  const list = useQuery({
    queryKey: ['official-plugins', assignment],
    queryFn: () => getOfficialPlugins(assignment),
    retry: false,
  })
  const change = useMutation({
    mutationFn: (input: { action: OfficialPluginAction; name: string }) =>
      requestOfficialPluginChange(input, assignment),
    onSuccess: (view) => {
      setError(undefined)
      client.setQueryData(['official-plugins', assignment], view)
      void client.invalidateQueries({ queryKey: ['deck'] })
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  return (
    <Card data-testid="official-plugins">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Puzzle className="size-4" aria-hidden />
          {t('plugins.title')}
          <Hint text={t('plugins.hint')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <SafetyNote text={t('plugins.safety')} />
        {list.isPending ? <Skeleton className="h-10" /> : null}
        {list.data?.blocked_reason === undefined ? null : (
          <p className="text-xs text-muted-foreground" data-testid="plugins-blocked">
            {list.data.blocked_reason}
          </p>
        )}
        {list.data === undefined || list.data.plugins.length === 0 ? null : (
          <ul className="flex flex-col gap-2">
            {list.data.plugins.map((p) => (
              <Row
                key={p.name}
                plugin={p}
                busy={change.isPending && change.variables?.name === p.name}
                onAct={(action) => {
                  change.mutate({ action, name: p.name })
                }}
              />
            ))}
          </ul>
        )}
        {error === undefined ? null : (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

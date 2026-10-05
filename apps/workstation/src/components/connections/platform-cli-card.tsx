/**
 * WP216（Luoye 10-05「也要引导用户设置 Shopify CLI 啥的」）：**平台官方 CLI 卡**。
 *
 * 这张卡里没有一个平台名：叫什么、装的命令、登录命令、教程是哪篇，全来自服务端那一行
 * `PLATFORM_KITS`（`GET /v1/platform-kit`）。品牌的平台没有 CLI（WooCommerce / 还没建站…）
 * 服务端回 `kit: null`，这里**什么都不画**——卡不出、也不检测本机。
 *
 * 四条：
 *
 * 1. **状态用图标**（36 §7 第四档）：装好 / Node / 登录三格；好了之后卡上只剩这一排。
 * 2. **说明只在没好的时候**：缺哪一步就只给那一步——没装给安装命令、Node 不够给门槛、没登录给登录命令；
 *    长的步骤在教程里（「看教程」）。
 * 3. **登录永远是用户本人在浏览器里做**：我们只给命令让他复制到自己的终端，他登完点「我登好了」——
 *    这里一个账号、一个密码、一个令牌都不碰。
 * 4. **没好之前照实说降级**：网页模板先走店铺后台接口（不能本地预览）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Cpu, LogIn, PackageOpen, RefreshCw, SquareTerminal, Store } from 'lucide-react'
import { useState } from 'react'
import { StatusIcons, type StatusItem } from '@/components/design/status-icons'
import { TutorialLink } from '@/components/help/tutorial-link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import {
  checkPlatformCli,
  confirmPlatformCliLogin,
  getPlatformKit,
  getPositions,
  type PlatformCliView,
  type PlatformKitView,
  setPlatformKitPlatform,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { HELP_SLUGS, type HelpSlug } from '@/lib/help'

const isHelpSlug = (s: string): s is HelpSlug => (HELP_SLUGS as readonly string[]).includes(s)

/** 一条可复制的命令（等宽、一键复制）。 */
function CommandLine({ command, testId }: { command: string; testId: string }): React.ReactNode {
  const { t } = useApp()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid={testId}>
        {command}
      </code>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 gap-1 px-2 text-xs"
        onClick={() => {
          void globalThis.navigator?.clipboard?.writeText(command).then(() => setCopied(true))
        }}
      >
        <Copy className="size-3" aria-hidden />
        {copied ? t('platform_cli.copied') : t('platform_cli.copy')}
      </Button>
    </div>
  )
}

export function cliStatusItems(
  cli: PlatformCliView,
  t: (key: string, vars?: Record<string, string>) => string,
  mcp?: NonNullable<PlatformKitView['kit']>['mcp'],
): StatusItem[] {
  const probe = cli.probe
  const installed = probe?.installed === true
  // WP216：官方工具包（Dev MCP）——首次使用才下载；这台机器关了就不画这一格
  const toolkit: StatusItem[] =
    mcp === undefined || !mcp.enabled
      ? []
      : [
          {
            key: 'toolkit',
            label: t('platform_cli.item.toolkit'),
            icon: PackageOpen,
            state: mcp.downloaded ? 'ok' : 'unknown',
            ...(mcp.downloaded ? {} : { stateText: t('platform_cli.toolkit_first_use') }),
            detail: `${mcp.label} ${mcp.version}`,
          },
        ]
  return [
    {
      key: 'installed',
      label: t('platform_cli.item.installed'),
      icon: SquareTerminal,
      state: installed ? 'ok' : 'fail',
      ...(probe?.version === undefined ? {} : { value: probe.version }),
    },
    {
      key: 'node',
      label: t('platform_cli.item.node'),
      icon: Cpu,
      state: probe?.node_ok === true ? 'ok' : 'fail',
      ...(probe?.node_version === undefined ? {} : { value: probe.node_version }),
      detail: t('platform_cli.node_need', { min: String(cli.spec.min_node_major) }),
    },
    {
      key: 'login',
      label: t('platform_cli.item.login'),
      icon: LogIn,
      state: cli.login_confirmed_at !== undefined ? 'ok' : 'unknown',
    },
    ...toolkit,
  ]
}

/**
 * WP216（Fable 10-05）：品牌还没设建站平台时，建站岗位页上那一行「先选一下你的建站平台」+ 下拉。
 * 选平台是改品牌档案，只有负责人能改——用负责人那条分配发；不是负责人就只说一句、不给下拉。
 */
function ChoosePlatformRow({
  choices,
  positionId,
  onSaved,
}: {
  choices: NonNullable<PlatformKitView['choose_platform']>['choices']
  positionId?: string
  onSaved: (next: PlatformKitView) => void
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const owner = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const save = useMutation({
    mutationFn: (storefront_platform: string) =>
      setPlatformKitPlatform(
        { storefront_platform, ...(positionId === undefined ? {} : { position_id: positionId }) },
        owner,
      ),
    onSuccess: (next) => {
      onSaved(next)
      // 技能页、连接页都跟着平台变
      void client.invalidateQueries({ queryKey: ['skills'] })
      void client.invalidateQueries({ queryKey: ['platform-kit'] })
    },
  })
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
      data-testid="platform-choose"
    >
      <Store className="size-4" aria-hidden />
      <span>{t('platform_choose.title')}</span>
      {owner === undefined ? (
        <span className="text-xs text-muted-foreground" data-testid="platform-choose-ask-owner">
          {t('platform_choose.ask_owner')}
        </span>
      ) : (
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          defaultValue=""
          disabled={save.isPending}
          data-testid="platform-choose-select"
          aria-label={t('platform_choose.title')}
          onChange={(e) => {
            if (e.target.value !== '') save.mutate(e.target.value)
          }}
        >
          <option value="" disabled>
            {t('platform_choose.placeholder')}
          </option>
          {choices.map((c) => (
            <option key={c.key} value={c.key} disabled={!c.supported}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      {save.error === null ? null : (
        <span role="alert" className="text-xs text-destructive">
          {save.error.message}
        </span>
      )}
    </div>
  )
}

export function PlatformCliCard({
  positionId,
  assignment,
}: {
  /** 在哪个岗位页上（只在平台那一行写的岗位上出）；连接页不传。 */
  positionId?: string
  /** 连接页用店主那条分配；岗位页用当前的。 */
  assignment?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const key = ['platform-kit', positionId ?? '', assignment ?? '']
  const view = useQuery({
    queryKey: key,
    queryFn: () =>
      getPlatformKit(positionId === undefined ? {} : { position_id: positionId }, assignment),
  })
  const set = (next: PlatformKitView): void => {
    client.setQueryData(key, next)
  }
  const recheck = useMutation({ mutationFn: () => checkPlatformCli(assignment), onSuccess: set })
  const login = useMutation({
    mutationFn: (confirmed: boolean) => confirmPlatformCliLogin(confirmed, assignment),
    onSuccess: set,
  })
  const choose = view.data?.choose_platform
  if (choose !== undefined)
    return (
      <ChoosePlatformRow
        choices={choose.choices}
        {...(positionId === undefined ? {} : { positionId })}
        onSaved={set}
      />
    )
  const cli = view.data?.kit?.cli
  // 平台没有 CLI / 不是这个岗位 / 还在查 / 查失败：都不出卡
  if (cli === undefined) return null
  const spec = cli.spec
  const install = spec.install[0]

  return (
    <Card data-testid="platform-cli-card" data-cli={spec.id} data-state={cli.state}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <SquareTerminal className="size-4" aria-hidden />
          {spec.label}
          <Hint text={t('platform_cli.hint')} />
          {isHelpSlug(spec.tutorial) ? <TutorialLink slug={spec.tutorial} /> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <StatusIcons
          items={cliStatusItems(cli, t, view.data?.kit?.mcp)}
          label={spec.label}
          testId="platform-cli-status"
        />
        {cli.state === 'ready' ? null : (
          <>
            <p className="text-xs text-muted-foreground" data-testid="platform-cli-degraded">
              {t('platform_cli.degraded')}
            </p>
            <p className="text-sm" data-testid="platform-cli-step">
              {t(`platform_cli.step.${cli.state}`, { min: String(spec.min_node_major) })}
            </p>
            {cli.state === 'missing' && install !== undefined ? (
              <CommandLine command={install.command} testId="platform-cli-install" />
            ) : null}
            {cli.state === 'needs_login' ? (
              <CommandLine command={spec.login_command} testId="platform-cli-login" />
            ) : null}
            <div className="flex flex-wrap gap-2">
              {cli.state === 'needs_login' ? (
                <Button
                  size="sm"
                  disabled={login.isPending}
                  onClick={() => login.mutate(true)}
                  data-testid="platform-cli-login-done"
                >
                  {t('platform_cli.login_done')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  disabled={recheck.isPending}
                  onClick={() => recheck.mutate()}
                  data-testid="platform-cli-recheck"
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  {t('platform_cli.recheck')}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * WP216（Luoye 10-05「也要引导用户设置 Shopify CLI 啥的」）：**平台官方 CLI 卡**。
 * WP245（Luoye 10-07 Windows 真机：「能不能像 Claude 一样把终端集成进来，自动装、自动跑」）：
 * **用户不开终端、不装 Node、不敲命令**——工作台在后台替他跑工具包里登记过的那几条命令。
 *
 * 这张卡里没有一个平台名：叫什么、装哪个包、登录谁、教程是哪篇，全来自服务端那一行
 * `PLATFORM_KITS`（`GET /v1/platform-kit`）。品牌的平台没有 CLI（WooCommerce / 还没建站…）
 * 服务端回 `kit: null`，这里**什么都不画**。
 *
 * 五条：
 *
 * 1. **状态用图标**（36 §7 第四档）：装好 / 登录（Node 只有在不够时才出那一格）；好了之后卡上只剩这一排。
 * 2. **界面少字**：没好的时候主状态一行 + 一个主按钮（「一键安装」/「登录 X」）；命令、日志、版本号
 *    收进「详情」折叠；降级说明进标题旁的问号。
 * 3. **一键安装**：服务端用安装包自带的 node 把 CLI 装进应用自己的数据目录，这里画进度
 *    （下载中 / 安装中 / 装好了 / 失败一句人话 + 重试）。
 * 4. **一键登录**：服务端起登录命令、解析出登录网址，**这里交给系统浏览器打开**（桌面壳走
 *    `shell.openExternal`）；登录期间「浏览器里登录完回来就行」+ 取消；进程结束自动复查、卡片变绿。
 *    账号密码只在平台网页上输，这里一个都不经手。
 * 5. 这台机器不能自动装（服务端没有数据目录）才退回「复制这条命令到终端」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Loader2,
  LogIn,
  PackageOpen,
  RefreshCw,
  SquareTerminal,
  Store,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { openExternal } from '@/components/connections/bridge'
import { StatusIcons, type StatusItem } from '@/components/design/status-icons'
import { TutorialLink } from '@/components/help/tutorial-link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import {
  cancelPlatformCli,
  getPlatformKit,
  getPositions,
  type PlatformCliJob,
  type PlatformCliView,
  type PlatformKitView,
  runPlatformCli,
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
  // WP245：CLI 装在工作台自己那份 node 上，Node 一般不用用户操心——只有不够时才出这一格
  const nodeItem: StatusItem[] =
    cli.state === 'node_old' || (probe?.installed === true && probe.node_ok !== true)
      ? [
          {
            key: 'node',
            label: t('platform_cli.item.node'),
            icon: Cpu,
            state: 'fail',
            ...(probe?.node_version === undefined ? {} : { value: probe.node_version }),
            detail: t('platform_cli.node_need', { min: String(cli.spec.min_node_major) }),
          },
        ]
      : []
  return [
    {
      key: 'installed',
      label: t('platform_cli.item.installed'),
      icon: SquareTerminal,
      state: installed ? 'ok' : 'fail',
      ...(probe?.version === undefined ? {} : { value: probe.version }),
    },
    ...nodeItem,
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

/** 登录 / 安装还在走（要接着问状态）。 */
const RUNNING = new Set<PlatformCliJob['phase']>([
  'preparing',
  'downloading',
  'installing',
  'waiting_browser',
])
const isRunning = (job: PlatformCliJob | undefined): job is PlatformCliJob =>
  job !== undefined && RUNNING.has(job.phase)

/** 跑着的时候多久问一次。 */
const POLL_MS = 1500

/** 正在跑的那一行：转圈 + 一句话（+ 登录时的「没弹出来？」与确认码）。 */
function JobLine({ job }: { job: PlatformCliJob }): React.ReactNode {
  const { t } = useApp()
  const text =
    job.action === 'login'
      ? job.login_url === undefined
        ? t('platform_cli.job.opening')
        : t('platform_cli.job.waiting_browser')
      : t(`platform_cli.job.${job.phase}`)
  return (
    <div className="flex flex-col gap-1" data-testid="platform-cli-job" data-phase={job.phase}>
      <p className="flex items-center gap-2 text-sm" data-testid="platform-cli-step">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {text}
        {job.action === 'install' && (job.fetched ?? 0) > 0 ? (
          <span className="text-xs text-muted-foreground">
            {t('platform_cli.job.fetched', { n: String(job.fetched) })}
          </span>
        ) : null}
      </p>
      {job.action === 'login' && job.login_url !== undefined ? (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <button
            type="button"
            className="inline-flex items-center gap-1 underline underline-offset-2"
            onClick={() => {
              if (job.login_url !== undefined) openExternal(job.login_url)
            }}
            data-testid="platform-cli-reopen"
          >
            <ExternalLink className="size-3" aria-hidden />
            {t('platform_cli.job.reopen')}
          </button>
          {job.user_code === undefined ? null : (
            <span data-testid="platform-cli-code">
              {t('platform_cli.job.user_code', { code: job.user_code })}
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 「详情」：版本、命令、输出尾巴、自己在终端里跑的那两条（默认收着）。 */
function CliDetails({ cli }: { cli: PlatformCliView }): React.ReactNode {
  const { t } = useApp()
  const probe = cli.probe
  const install = cli.spec.install[0]
  const job = cli.job
  return (
    <details className="text-xs text-muted-foreground" data-testid="platform-cli-details">
      <summary className="cursor-pointer select-none">{t('platform_cli.details')}</summary>
      <div className="mt-2 flex flex-col gap-2">
        {probe?.version === undefined ? null : (
          <p data-testid="platform-cli-version">
            {t('platform_cli.details.version', { version: probe.version })}
            {probe.source === undefined
              ? null
              : ` · ${t(`platform_cli.details.source.${probe.source}`)}`}
          </p>
        )}
        {job === undefined ? null : (
          <>
            <code className="break-all font-mono" data-testid="platform-cli-command">
              {job.command}
            </code>
            {job.log.length === 0 ? null : (
              <pre
                className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-[11px]"
                data-testid="platform-cli-log"
              >
                {job.log.slice(-30).join('\n')}
              </pre>
            )}
          </>
        )}
        <p>{t('platform_cli.details.manual')}</p>
        {install === undefined ? null : (
          <CommandLine command={install.command} testId="platform-cli-install" />
        )}
        <CommandLine command={cli.spec.login_command} testId="platform-cli-login" />
      </div>
    </details>
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
    // 安装 / 登录跑着的时候接着问（进度、登录网址、结束后自动复查）
    refetchInterval: (q) => (isRunning(q.state.data?.kit?.cli?.job) ? POLL_MS : false),
  })
  const set = (next: PlatformKitView): void => {
    client.setQueryData(key, next)
  }
  const run = useMutation({
    mutationFn: (action: 'install' | 'login' | 'version') => runPlatformCli(action, assignment),
    onSuccess: set,
  })
  const cancel = useMutation({ mutationFn: () => cancelPlatformCli(assignment), onSuccess: set })
  const cli = view.data?.kit?.cli
  const job = cli?.job
  // 登录网址一出来就交给系统浏览器（CLI 自己已经开了就不再开第二次）；同一次登录只开一回
  const opened = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (job?.action !== 'login' || job.login_url === undefined) return
    if (job.browser_opened === true || opened.current === job.started_at) return
    opened.current = job.started_at
    openExternal(job.login_url)
  }, [job?.action, job?.login_url, job?.browser_opened, job?.started_at])

  const choose = view.data?.choose_platform
  if (choose !== undefined)
    return (
      <ChoosePlatformRow
        choices={choose.choices}
        {...(positionId === undefined ? {} : { positionId })}
        onSaved={set}
      />
    )
  // 平台没有 CLI / 不是这个岗位 / 还在查 / 查失败：都不出卡
  if (cli === undefined) return null
  const spec = cli.spec
  const install = spec.install[0]
  const running = isRunning(job)
  const canInstall = cli.can?.install === true
  const canLogin = cli.can?.login === true
  // 上一次替用户跑的那件失败了（而且状态没变）：一句人话 + 重试
  const failed = job?.phase === 'failed' ? job : undefined
  const name = spec.account_label ?? spec.label
  const wantInstall = cli.state === 'missing' || cli.state === 'node_old'

  const primary = (): React.ReactNode => {
    if (running)
      return (
        <Button
          size="sm"
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
          data-testid="platform-cli-cancel"
        >
          {t('platform_cli.cancel')}
        </Button>
      )
    if (wantInstall && canInstall)
      return (
        <Button
          size="sm"
          className="gap-1"
          disabled={run.isPending}
          onClick={() => run.mutate('install')}
          data-testid="platform-cli-install-run"
        >
          <Download className="size-3.5" aria-hidden />
          {failed?.action === 'install' ? t('platform_cli.retry') : t('platform_cli.install')}
        </Button>
      )
    if (cli.state === 'needs_login' && canLogin)
      return (
        <Button
          size="sm"
          className="gap-1"
          disabled={run.isPending}
          onClick={() => run.mutate('login')}
          data-testid="platform-cli-login-run"
        >
          <LogIn className="size-3.5" aria-hidden />
          {t('platform_cli.login', { name })}
        </Button>
      )
    return null
  }

  const stepText = (): string =>
    wantInstall && !canInstall
      ? t('platform_cli.step.manual')
      : t(`platform_cli.step.${cli.state}`, { min: String(spec.min_node_major), name })

  return (
    <Card data-testid="platform-cli-card" data-cli={spec.id} data-state={cli.state}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <SquareTerminal className="size-4" aria-hidden />
          {spec.label}
          <Hint
            text={
              cli.state === 'ready'
                ? t('platform_cli.hint')
                : `${t('platform_cli.hint')} ${t('platform_cli.degraded')}`
            }
          />
          {isHelpSlug(spec.tutorial) ? <TutorialLink slug={spec.tutorial} /> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <StatusIcons
          items={cliStatusItems(cli, t, view.data?.kit?.mcp)}
          label={spec.label}
          testId="platform-cli-status"
        />
        {running ? <JobLine job={job} /> : null}
        {!running && cli.state !== 'ready' ? (
          <p className="text-sm" data-testid="platform-cli-step">
            {stepText()}
          </p>
        ) : null}
        {!running && failed !== undefined && cli.state !== 'ready' ? (
          <p role="alert" className="text-xs text-destructive" data-testid="platform-cli-error">
            {t(`platform_cli.error.${failed.error?.code ?? 'failed'}`)}
            {failed.error?.detail === undefined ? null : (
              <span className="ml-1 font-mono text-muted-foreground">{failed.error.detail}</span>
            )}
          </p>
        ) : null}
        {!running && wantInstall && !canInstall && install !== undefined ? (
          <CommandLine command={install.command} testId="platform-cli-install-manual" />
        ) : null}
        {run.error === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {run.error.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {primary()}
          {running ? null : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground"
              disabled={run.isPending}
              onClick={() => run.mutate('version')}
              data-testid="platform-cli-recheck"
            >
              <RefreshCw className="size-3" aria-hidden />
              {t('platform_cli.recheck')}
            </Button>
          )}
        </div>
        <CliDetails cli={cli} />
      </CardContent>
    </Card>
  )
}

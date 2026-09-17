/**
 * 设置 → **浏览器**（55 §3 末段，WP82）。
 *
 * 一句话：有些活只能在网页上干（YouTube 的频道页、Amazon 卖家后台），
 * 这一节告诉工作台**用哪个浏览器**去干。两种方式：
 *
 * | 方式 | 人话 | 什么时候用 |
 * |---|---|---|
 * | 连接我电脑上的 Chrome | 用你自己那个已经登录好的 Chrome | 平常用这个：不用再登一次，验证码也是你自己过 |
 * | 用独立的 Chrome | 指一个 Chrome 的可执行文件，每次起一个干净的 | 服务不在你这台电脑上，或者你不想让 AI 碰你的登录态 |
 * | 我正在用的浏览器（WP92 / 55 §10） | 腾讯 BrowserSkill：浏览器扩展 + 本机 `bsk`，附到你日常那个浏览器上 | 要看"登录之后才看得到"的东西，而且不想另开一个浏览器 |
 *
 * 第三种多一步向导（装扩展 → 装 `bsk` → `bsk doctor` 检查），因为它有两个**我们装不了**
 * 的前提：扩展只能用户自己在浏览器里装，`bsk` 是一个本机小程序。向导把这两步摆出来，
 * 第三步按钮跑一次上游自己的体检，把它那几条原样端出来（含"怎么修"那一句）。
 *
 * 三条界面纪律：
 * 1. **默认是"不开"**。不配 = 没有哪条职责开得了浏览器。这是安全的那一侧，
 *    也是诚实的那一侧：没配好就说没配好，不要半开着。
 * 2. **attach 那一项在非个人档上是灰的**，而且下面写清楚为什么（服务不在你电脑上，
 *    `127.0.0.1` 指的是容器自己）。灰掉但不解释等于让人以为坏了。
 * 3. **不替用户下载浏览器**。"独立的 Chrome"要用户自己指一个可执行文件——
 *    我们没给 playwright 的 postinstall 开构建（16 §3），也不打算偷偷下几百兆。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Globe, Loader2, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  type BrowserProbeResult,
  type BrowserSettings,
  type BrowserSkillStatus,
  getBrowserSettings,
  getBrowserSkillStatus,
  installBrowserSkill,
  probeBrowser,
  setBrowserSettings,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 桌面壳托盘里那条"打开工作用的浏览器"挑的端口（`apps/desktop`）。 */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:9333'

/**
 * WP92：扩展的两个官方商店地址（`browserskill.lock.json` 里也有同一份，
 * 那一份给的是安装器；这里是给人点的）。**只给官方商店**——"加载已解压的扩展"
 * 那条路要用户自己下 zip、进开发者模式，不该是向导的默认建议。
 */
const BSK_STORE = {
  chrome: 'https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi',
  edge: 'https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg',
} as const

/** 一步向导的外框（编号 + 标题 + 说明 + 右边那个按钮 / 状态）。 */
function Step({
  title,
  note,
  children,
}: {
  title: string
  note: string
  children?: React.ReactNode
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-2.5">
      <span className="text-xs font-medium">{title}</span>
      <span className="text-[11px] text-muted-foreground">{note}</span>
      {children}
    </div>
  )
}

export function BrowserCard({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const settings = useQuery({
    queryKey: ['browser-settings', assignment],
    queryFn: () => getBrowserSettings(assignment),
    retry: false,
  })

  const [mode, setMode] = useState<BrowserSettings['mode'] | undefined>(undefined)
  const [endpoint, setEndpoint] = useState('')
  const [path, setPath] = useState('')
  const [probe, setProbe] = useState<BrowserProbeResult | undefined>(undefined)

  // 服务端那一份到了就把表单填上（用户还没动过表单的时候）
  useEffect(() => {
    if (settings.data === undefined || mode !== undefined) return
    setMode(settings.data.mode)
    setEndpoint(settings.data.endpoint ?? DEFAULT_ENDPOINT)
    setPath(settings.data.executable_path ?? '')
  }, [settings.data, mode])

  /*
   * WP92：第三种方式装到哪一步了。**按钮按了才查**，不跟着设置页一起加载——
   * `bsk doctor` 会起一个子进程、还要等浏览器扩展连上来（上游默认等几秒）。
   * 打开设置页就跑一遍，等于每次看一眼设置都去戳一下用户的浏览器。
   */
  const [bsk, setBsk] = useState<BrowserSkillStatus | undefined>(undefined)
  const bskInstall = useMutation({
    mutationFn: () => installBrowserSkill(assignment),
    onSuccess: setBsk,
  })
  const bskCheck = useMutation({
    mutationFn: () => getBrowserSkillStatus(assignment),
    onSuccess: setBsk,
  })

  const save = useMutation({
    mutationFn: (input: BrowserSettings) => setBrowserSettings(input, assignment),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['browser-settings'] })
    },
  })
  const find = useMutation({
    mutationFn: () => probeBrowser(undefined, assignment),
    onSuccess: (result) => {
      setProbe(result)
      if (result.ok) setEndpoint(result.endpoint)
    },
  })
  const test = useMutation({
    mutationFn: () => probeBrowser(endpoint, assignment),
    onSuccess: setProbe,
  })

  if (settings.isPending) return <Skeleton className="h-40 w-full" />
  // 服务进程没装配这一节（not_implemented）就整张卡不出——不摆一张点不动的卡
  if (settings.isError) return null

  const view = settings.data
  const attachAllowed = view?.attach_allowed === true
  const bskAllowed = view?.browserskill_allowed === true
  const current = mode ?? view?.mode ?? 'off'
  const busy = save.isPending || find.isPending || test.isPending
  const failure = save.error
  const probing = find.isPending || test.isPending

  const submit = (): void => {
    setProbe(undefined)
    if (current === 'attach') save.mutate({ mode: 'attach', endpoint: endpoint.trim() })
    else if (current === 'launch')
      save.mutate({ mode: 'launch', executable_path: path.trim(), headless: true })
    else if (current === 'browserskill') save.mutate({ mode: 'browserskill' })
    else save.mutate({ mode: 'off' })
  }

  const option = (value: BrowserSettings['mode'], label: string, note: string, off = false) => (
    <label
      className={`flex items-start gap-2 rounded-md border p-2.5 ${
        off ? 'opacity-50' : 'cursor-pointer'
      } ${current === value ? 'border-primary' : ''}`}
      data-testid={`browser-mode-${value}`}
    >
      <input
        type="radio"
        name="browser-mode"
        className="mt-0.5"
        checked={current === value}
        disabled={off}
        onChange={() => {
          setMode(value)
          setProbe(undefined)
        }}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </span>
    </label>
  )

  return (
    <Card data-testid="settings-browser" data-mode={view?.mode ?? 'off'}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1 text-sm">
          <Globe className="size-4" aria-hidden />
          {t('settings.browser')}
          <Hint text={t('settings.browser.hint')} testId="settings-browser-hint" />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-muted-foreground">{t('settings.browser.summary')}</p>

        {option('off', t('settings.browser.off'), t('settings.browser.off.note'))}

        {option(
          'attach',
          t('settings.browser.attach'),
          attachAllowed
            ? t('settings.browser.attach.note')
            : (view?.attach_blocked_reason ?? t('settings.browser.attach.blocked')),
          !attachAllowed,
        )}
        {current === 'attach' && attachAllowed ? (
          <div className="flex flex-col gap-2 pl-6">
            <div className="flex items-center gap-2">
              <input
                className="h-8 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
                value={endpoint}
                placeholder={DEFAULT_ENDPOINT}
                data-testid="browser-endpoint"
                onChange={(e) => {
                  setEndpoint(e.target.value)
                  setProbe(undefined)
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="browser-find"
                onClick={() => {
                  find.mutate()
                }}
              >
                {probing ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Search aria-hidden />
                )}
                {t('settings.browser.find')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                data-testid="browser-test"
                onClick={() => {
                  test.mutate()
                }}
              >
                {t('settings.browser.test')}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t('settings.browser.how')}</p>
          </div>
        ) : null}

        {option('launch', t('settings.browser.launch'), t('settings.browser.launch.note'))}
        {current === 'launch' ? (
          <div className="flex flex-col gap-2 pl-6">
            <input
              className="h-8 rounded-md border bg-background px-2 font-mono text-xs"
              value={path}
              placeholder="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
              data-testid="browser-executable"
              onChange={(e) => {
                setPath(e.target.value)
              }}
            />
            <p className="text-[11px] text-muted-foreground">{t('settings.browser.launch.hint')}</p>
          </div>
        ) : null}

        {option(
          'browserskill',
          t('settings.browser.bsk'),
          bskAllowed
            ? t('settings.browser.bsk.note')
            : (view?.browserskill_blocked_reason ?? t('settings.browser.bsk.blocked')),
          !bskAllowed,
        )}
        {current === 'browserskill' && bskAllowed ? (
          <div className="flex flex-col gap-2 pl-6" data-testid="browserskill-wizard">
            <Step
              title={t('settings.browser.bsk.step1')}
              note={t('settings.browser.bsk.step1.note')}
            >
              <span className="flex gap-3 text-[11px]">
                <a
                  className="underline"
                  href={BSK_STORE.chrome}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="browserskill-store-chrome"
                >
                  {t('settings.browser.bsk.step1.chrome')}
                </a>
                <a
                  className="underline"
                  href={BSK_STORE.edge}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="browserskill-store-edge"
                >
                  {t('settings.browser.bsk.step1.edge')}
                </a>
              </span>
            </Step>
            <Step
              title={t('settings.browser.bsk.step2')}
              note={t('settings.browser.bsk.step2.note')}
            >
              <span className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bskInstall.isPending}
                  data-testid="browserskill-install"
                  onClick={() => {
                    bskInstall.mutate()
                  }}
                >
                  {bskInstall.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {bsk?.installed === true
                    ? t('settings.browser.bsk.step2.reinstall')
                    : t('settings.browser.bsk.step2.install')}
                </Button>
                <span
                  className="text-[11px] text-muted-foreground"
                  data-testid="browserskill-installed"
                >
                  {bsk === undefined
                    ? ''
                    : bsk.installed
                      ? t('settings.browser.bsk.step2.installed', {
                          version: bsk.version ?? bsk.pinned_version ?? '?',
                          path: bsk.bsk_path ?? '',
                        })
                      : t('settings.browser.bsk.step2.missing')}
                </span>
              </span>
              {bskInstall.error === null || bskInstall.error === undefined ? null : (
                <span
                  className="text-[11px] text-destructive"
                  data-testid="browserskill-install-error"
                >
                  {bskInstall.error instanceof ApiClientError
                    ? bskInstall.error.message
                    : t('error.generic')}
                </span>
              )}
            </Step>
            <Step
              title={t('settings.browser.bsk.step3')}
              note={t('settings.browser.bsk.step3.note')}
            >
              <span className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bskCheck.isPending}
                  data-testid="browserskill-check"
                  onClick={() => {
                    bskCheck.mutate()
                  }}
                >
                  {bskCheck.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {t('settings.browser.bsk.step3.check')}
                </Button>
                {bsk === undefined ? null : (
                  <span
                    className={`text-[11px] ${bsk.ok ? 'text-muted-foreground' : 'text-destructive'}`}
                    data-testid="browserskill-result"
                    data-ok={bsk.ok}
                  >
                    {bsk.ok
                      ? t('settings.browser.bsk.ok')
                      : t('settings.browser.bsk.fail', { detail: bsk.detail ?? '' })}
                  </span>
                )}
              </span>
              {bsk === undefined || bsk.checks.length === 0 ? null : (
                <ul className="flex flex-col gap-0.5 pt-1" data-testid="browserskill-checks">
                  {bsk.checks.map((check) => (
                    <li key={check.name} className="flex items-start gap-1 text-[11px]">
                      {check.status === 'fail' ? (
                        <X className="size-3 shrink-0 text-destructive" aria-hidden />
                      ) : (
                        <Check className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <span className={check.status === 'fail' ? 'text-destructive' : ''}>
                        {check.name}：{check.detail}
                        {check.hint === undefined ? '' : `（${check.hint}）`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Step>
            <p className="text-[11px] text-muted-foreground">{t('settings.browser.bsk.compare')}</p>
          </div>
        ) : null}

        {probe === undefined ? null : (
          <p
            className={`text-xs ${probe.ok ? 'text-muted-foreground' : 'text-destructive'}`}
            data-testid="browser-probe-result"
            data-ok={probe.ok}
          >
            {probe.ok
              ? t('settings.browser.probe.ok', {
                  endpoint: probe.endpoint,
                  browser: probe.browser ?? 'Chrome',
                })
              : t('settings.browser.probe.fail', { detail: probe.detail ?? '' })}
          </p>
        )}

        {failure === null || failure === undefined ? null : (
          <p className="text-xs text-destructive" data-testid="browser-error">
            {failure instanceof ApiClientError ? failure.message : t('error.generic')}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy}
            data-testid="browser-save"
            onClick={() => {
              submit()
            }}
          >
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('settings.browser.save')}
          </Button>
          {save.isSuccess && !save.isPending ? (
            <span className="text-xs text-muted-foreground" data-testid="browser-saved">
              {t('settings.browser.saved')}
            </span>
          ) : null}
        </div>

        <p className="text-[11px] text-muted-foreground">{t('settings.browser.scope')}</p>
      </CardContent>
    </Card>
  )
}

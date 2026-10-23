/**
 * WP356：设置弹窗里那几行「小设置」——主题、语言、动效、登录身份、使用方式、快捷键、桌面端。
 * WP361（决策 927）：桌面端多一行「开机自启」开关（桥上有才出，和托盘那一项是同一份）。
 *
 * 原来主题 / 语言是一个按钮来回切（看不出还有别的选项），这里改成几选一的小胶囊；
 * 行为不变（同一个 `setTheme` / `setLang` / `setMotionPref`）。
 */
import { isPlaceholderOwnerEmail } from '@agentsws/contracts'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { MOTION_PREFS, setMotionPref, useMotionPref } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { UpdateButton } from '@/components/update-button'
import { ensureSession, listOrganizations } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { useAppVersion } from '@/lib/app-version'
import { Segmented, SettingRow } from './setting-row'

export function ThemeRow(): ReactNode {
  const { t, theme, setTheme } = useApp()
  return (
    <SettingRow
      testId="settings-theme"
      title={t('settings.theme')}
      desc={t('sp.theme.desc')}
      control={
        <Segmented
          label={t('settings.theme')}
          testId="settings-theme-pick"
          value={theme}
          options={[
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ]}
          onChange={setTheme}
        />
      }
    />
  )
}

export function LanguageRow(): ReactNode {
  const { t, lang, setLang } = useApp()
  return (
    <SettingRow
      testId="settings-lang"
      title={t('settings.lang')}
      desc={t('sp.lang.desc')}
      control={
        <Segmented
          label={t('settings.lang')}
          testId="settings-lang-pick"
          value={lang}
          options={[
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' },
          ]}
          onChange={setLang}
        />
      }
    />
  )
}

/** WP195：界面动效——跟随系统（默认）/ 开 / 关。管的是品牌标记的动效，加载转圈不归它管。 */
export function MotionRow(): ReactNode {
  const { t } = useApp()
  const motionPref = useMotionPref()
  return (
    <SettingRow
      title={t('settings.motion')}
      desc={t('sp.motion.desc')}
      hint={t('settings.motion.hint')}
      control={
        <Segmented
          label={t('settings.motion')}
          testId="settings-motion"
          value={motionPref}
          options={MOTION_PREFS.map((m) => ({ value: m, label: t(`settings.motion.${m}`) }))}
          onChange={setMotionPref}
        />
      }
    />
  )
}

/** 登录身份（WP233：本机占位邮箱不露出来）。 */
export function IdentityRow(): ReactNode {
  const { t } = useApp()
  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession, retry: false })
  const email = session.data?.person.email
  if (email === undefined) return null
  return (
    <SettingRow
      title={t('sp.identity')}
      desc={t('sp.identity.desc')}
      control={
        <span className="font-mono text-xs text-muted-foreground" data-testid="settings-identity">
          {isPlaceholderOwnerEmail(email) ? t('identity.local_self') : email}
        </span>
      }
    />
  )
}

/** WP426：「个人与团队」三张可选卡（在 `usage-mode.tsx`）。 */
export { UsageModePicker as UsageModeRow } from './usage-mode'

/**
 * 52 O1「公司」那一行：公司叫什么、几个品牌几个人、去「全部品牌」管；底下一行小字开 / 关公司模式（WP277）。
 * 个人（一个人一个品牌）不出——对他来说「公司」这一层不存在。
 */
export function OrgSummaryRow(): ReactNode {
  const { t } = useApp()
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => listOrganizations(), retry: false })
  const org = orgs.data?.[0]
  if (org === undefined || org.solo) return null
  return (
    <div className="flex flex-col gap-1 py-3" data-testid="settings-org">
      <SettingRow
        className="py-0"
        title={t('settings.org')}
        desc={t('sp.company.desc')}
        hint={t('settings.org.hint')}
        control={
          <span className="text-xs text-muted-foreground">
            <span className="font-medium text-ws-ink">{org.legal_name}</span> ·{' '}
            {t('settings.org.brands', { n: org.brands })} ·{' '}
            {t('settings.org.members', { n: org.members })}
          </span>
        }
      />
      {/* WP426：开 / 关公司模式挪到上面那三张卡上，这里只留去「全部品牌」 */}
      {/* WP456-T6（§3.8 P1）：能点的字一律 `ws-link`（原来是绿字、没有下划线，看不出能点） */}
      <Link
        to="/settings/brands"
        className="ws-link w-fit text-ws-ui"
        data-testid="settings-org-manage"
      >
        {t('sp.brands')}
      </Link>
    </div>
  )
}

/** 键盘上能直接用的几个键（只列真的全局生效的）。 */
const KEYS: readonly [string, string][] = [
  ['⌘ K', 'sp.key.palette'],
  ['⌘ ,', 'sp.key.settings'],
  ['Esc', 'sp.key.close'],
  ['Enter', 'sp.key.send'],
  ['Shift Enter', 'sp.key.newline'],
]

export function ShortcutsList(): ReactNode {
  const { t } = useApp()
  return (
    <ul className="flex flex-col divide-y divide-ws-line" data-testid="settings-shortcuts">
      {KEYS.map(([keys, label]) => (
        <li key={keys} className="flex items-center justify-between py-2.5 text-sm">
          <span className="text-ws-body">{t(label)}</span>
          <kbd className="ws-num rounded-md border bg-ws-surface px-2 py-0.5 text-xs text-ws-ink">
            {keys}
          </kbd>
        </li>
      ))}
    </ul>
  )
}

/** WP426：桌面壳桥上的「检查更新」（旧壳 / 网页里没有）。 */
function updateCheckBridge(): (() => Promise<{ state: string }>) | undefined {
  const w = globalThis.window as unknown as
    | { agentsws?: { update?: { check?: () => Promise<{ state: string }> } } }
    | undefined
  const check = w?.agentsws?.update?.check
  return check === undefined ? undefined : () => check()
}

/**
 * 版本与更新（WP426：Luoye 问「在哪能看到我装的版本」）：当前版本常显；桌面壳里旁边一个「检查更新」，
 * 查到新版时就是左下角那个「更新」钮（同一个件）；查完没有新版说一句「已是最新」。
 * 网页里（没有壳）显示服务端报的版本，不给检查按钮（更新归桌面壳管）。
 */
export function AppUpdateRow(): ReactNode {
  const { t } = useApp()
  const { version } = useAppVersion()
  const [check] = useState(updateCheckBridge)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<'none' | 'failed' | undefined>(undefined)
  return (
    <SettingRow
      testId="settings-app-update"
      title={t('sp.app_update')}
      desc={version === undefined ? t('sp.app_update.desc') : t('sp.version.current', { version })}
      control={
        <span className="flex items-center gap-2 text-xs text-ws-muted-fg">
          {result === undefined ? null : (
            <span data-testid="settings-update-result">
              {result === 'none' ? t('sp.app_update.none') : t('sp.version.check_failed')}
            </span>
          )}
          <UpdateButton />
          {check === undefined ? null : (
            <Button
              size="sm"
              variant="secondary"
              disabled={checking}
              data-testid="settings-update-check"
              onClick={() => {
                setChecking(true)
                setResult(undefined)
                void check()
                  .then(
                    (s) => {
                      // 有新版时左下角与这里的「更新」钮自己会出来；没有就说一句
                      if (s.state === 'idle') setResult('none')
                    },
                    () => {
                      setResult('failed')
                    },
                  )
                  .finally(() => {
                    setChecking(false)
                  })
              }}
            >
              {checking ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {t('sp.version.check')}
            </Button>
          )}
        </span>
      }
    />
  )
}

/** 桌面壳桥上的开机自启（形状同 `@agentsws/desktop/bridge` 的 `DesktopLaunchAtLoginBridge`）。 */
export interface LaunchAtLoginBridgeLike {
  get(): Promise<boolean>
  set(on: boolean): Promise<boolean>
  onChange(listener: (on: boolean) => void): () => void
}

/** 旧壳、网页里没有（那就不出这个开关）。 */
export function launchAtLoginBridge(): LaunchAtLoginBridgeLike | undefined {
  const w = globalThis.window as unknown as
    | { agentsws?: { launchAtLogin?: LaunchAtLoginBridgeLike } }
    | undefined
  return w?.agentsws?.launchAtLogin
}

/**
 * WP361（决策 927）：开机自启——托盘菜单那一项照旧在，两边是同一份：这里一改托盘跟着勾，
 * 托盘那边一点这里跟着变（壳发一声 `onChange`）。读到之前不画开关（免得先画「关」再跳成「开」）。
 */
export function LaunchAtLoginRow(): ReactNode {
  const { t } = useApp()
  const [bridge] = useState(launchAtLoginBridge)
  const [on, setOn] = useState<boolean | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (bridge === undefined) return
    let alive = true
    void bridge.get().then(
      (v) => {
        if (alive) setOn(v)
      },
      () => undefined,
    )
    const off = bridge.onChange((v) => {
      setOn(v)
    })
    return () => {
      alive = false
      off()
    }
  }, [bridge])
  if (bridge === undefined) return null
  return (
    <SettingRow
      testId="settings-launch-at-login"
      title={t('sp.launch_at_login')}
      desc={t('sp.launch_at_login.desc')}
      control={
        on === undefined ? null : (
          <Switch
            aria-label={t('sp.launch_at_login')}
            data-testid="settings-launch-at-login-switch"
            checked={on}
            disabled={busy}
            onCheckedChange={(v) => {
              setBusy(true)
              setOn(v)
              void bridge
                .set(v)
                .then(setOn, () => {
                  setOn(!v)
                })
                .finally(() => {
                  setBusy(false)
                })
            }}
          />
        )
      }
    />
  )
}

/** 暂停、导出诊断这几样在托盘菜单里（工作台改不了，只指个路；开机自启 WP361 起上面有开关）。 */
export function TrayRow(): ReactNode {
  const { t } = useApp()
  return <SettingRow title={t('sp.tray')} desc={t('sp.tray.desc')} control={null} />
}

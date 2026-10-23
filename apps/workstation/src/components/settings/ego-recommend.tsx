/**
 * WP483（决策 1658 / 1659）：**推荐装 ego**——首次设置第 ④ 步与「设置 → 浏览器」都用这一张。
 *
 * 三种样子：
 * - **没装**：一句为什么 + 「去下载」（ego 官网下载页，自己认 Mac / Windows；不给安装包直链、不代下载）+
 *   「装好了，再看一次」。Mac / Windows 各自的那几步进问号（界面少字）。
 * - **装了但连不上**（ego 没打开、首次引导没做完、工坊被「以管理员身份运行」）：服务端那一句下一步 + 「再看一次」。
 * - **就绪**：一行「ego 已就绪 · 版本」，问号里写首次用要在 ego 里点掉「显示通知」、登录要发帖的网站。
 *
 * 只是引导：装、注册、登录都是用户自己在 ego 里做，我们不碰账号密码。三种用法（个人 / 同事 / 公司）都出（1659），
 * 但要服务跑在用户这台电脑上（`allowed`）。
 */
import { CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import type { EgoBrowserStatus } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** ego 官网下载页（自己按平台给对的那一份）。 */
export const EGO_DOWNLOAD_URL = 'https://lite.ego.app/download'

/** 这台电脑是不是 Windows（只决定问号里写哪一套步骤）。 */
export function isWindowsClient(): boolean {
  try {
    return /windows|win32|win64/iu.test(navigator.userAgent)
  } catch {
    return false
  }
}

export function EgoRecommend({
  status,
  checking,
  onRecheck,
  onLater,
}: {
  status: EgoBrowserStatus | undefined
  checking?: boolean
  onRecheck(): void
  /** 首次设置里才有「先不装，用插件」。 */
  onLater?: () => void
}): React.ReactNode {
  const { t } = useApp()
  if (status === undefined || !status.allowed) return null
  const recheck = (
    <Button
      size="sm"
      variant="ghost"
      disabled={checking === true}
      data-testid="ego-recheck"
      onClick={onRecheck}
    >
      {checking === true ? (
        <Loader2 className="animate-spin" aria-hidden />
      ) : (
        <RefreshCw aria-hidden />
      )}
      {t('ego.recommend.recheck')}
    </Button>
  )
  if (status.installed && status.connected !== false)
    return (
      <p
        className="flex items-center gap-1 text-xs text-ws-muted-fg"
        data-slot="status"
        data-testid="ego-ready"
      >
        <CheckCircle2 className="size-3.5" aria-hidden />
        {t('ego.ready', { version: status.version ?? '?' })}
        <Hint text={t('ego.ready.hint')} testId="ego-ready-hint" />
      </p>
    )
  if (status.installed)
    return (
      <div className="flex flex-col gap-1 rounded-md border p-3" data-testid="ego-not-connected">
        <span className="text-sm font-medium" data-slot="title">
          {t('ego.recommend.title')}
        </span>
        <p
          className={`text-xs ${status.admin === true ? 'text-destructive' : 'text-ws-muted-fg'}`}
          data-slot="status"
          data-testid="ego-connect-detail"
        >
          {status.connect_detail ?? status.detail ?? ''}
        </p>
        <div className="flex items-center gap-2">{recheck}</div>
      </div>
    )
  const win = isWindowsClient()
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-3" data-testid="ego-recommend">
      <span className="flex items-center gap-1 text-sm font-medium" data-slot="title">
        {t('ego.recommend.title')}
        <Hint
          text={t(win ? 'ego.recommend.hint.win' : 'ego.recommend.hint.mac')}
          testId="ego-recommend-hint"
        />
      </span>
      <p className="text-xs text-ws-muted-fg">{t('ego.recommend.why')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" asChild>
          <a
            href={EGO_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer"
            data-slot="action"
            data-testid="ego-download"
            data-os={win ? 'windows' : 'mac'}
          >
            <Download aria-hidden />
            {t('ego.recommend.download')}
          </a>
        </Button>
        {recheck}
        {onLater === undefined ? null : (
          <Button size="sm" variant="ghost" data-testid="ego-later" onClick={onLater}>
            {t('ego.recommend.later')}
          </Button>
        )}
      </div>
    </div>
  )
}

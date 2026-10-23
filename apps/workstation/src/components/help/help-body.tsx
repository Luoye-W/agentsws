/**
 * WP156：一篇教程的正文（右栏「教程」面板与「看教程」的对话框退路共用）。
 *
 * 教程上官网（私有 docs/113 §4.3–4.4）起：正文问本机服务（官网拉回来的 / 随包的，它挑好），
 * 没回来就用随包那份。版本对不上时顶上一行：
 * - 这篇讲的东西这台还没有 →「{版本} 起才有 · 你现在是 {版本}」；
 * - 给的是随包那份（和这台对得上），官网上讲的是新版 →「新版里这部分变了」。
 * 右上角一个小图标「在官网打开」（有官网地址的才有）。
 */
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { openExternal } from '@/components/connections/bridge'
import { HelpArticle } from '@/components/help/help-article'
import { useHelpArticle } from '@/components/help/use-help'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/app-context'
import type { HelpSlug } from '@/lib/help'

export function HelpBody({ slug }: { slug: HelpSlug }): ReactNode {
  const { t } = useApp()
  const { article, pending } = useHelpArticle(slug)
  if (pending) return <Skeleton className="h-40 w-full" />
  if (article === null || article === undefined)
    return (
      <p className="text-sm text-ws-muted-fg" data-testid="help-missing">
        {t('help.missing')}
      </p>
    )
  const url = article.url
  const note = article.needs_newer_app
    ? t('help.needs_newer_app', { requires: article.requires ?? '' })
    : article.newer_online
      ? t('help.newer_online')
      : undefined
  return (
    <div className="flex flex-col gap-2" data-source={article.source}>
      {note === undefined && url === undefined ? null : (
        <div className="flex items-start gap-2">
          {note === undefined ? (
            <span className="flex-1" />
          ) : (
            <p
              className="flex-1 rounded-md bg-ws-warn-bg px-2 py-1 text-xs text-ws-warn"
              title={t('help.update_hint')}
              data-testid="help-version-note"
            >
              {note}
            </p>
          )}
          {url === undefined ? null : (
            <button
              type="button"
              className="ws-link-muted inline-flex shrink-0 items-center gap-0.5 text-xs"
              title={t('help.on_site')}
              aria-label={t('help.on_site')}
              data-testid="help-on-site"
              onClick={() => {
                openExternal(url)
              }}
            >
              <ExternalLink aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <HelpArticle markdown={article.markdown} />
    </div>
  )
}

/**
 * WP156：一篇教程的正文（右栏「教程」面板与「看教程」的对话框退路共用）。
 *
 * 原文是打包进来的 md（`lib/help.ts`），按当前语言取，英文没写退回中文。
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { HelpArticle } from '@/components/help/help-article'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/app-context'
import { type HelpSlug, loadHelpArticle } from '@/lib/help'

export function HelpBody({ slug }: { slug: HelpSlug }): ReactNode {
  const { t, lang } = useApp()
  const article = useQuery({
    queryKey: ['help-article', slug, lang],
    queryFn: () => loadHelpArticle(slug, lang).then((md) => md ?? null),
    staleTime: Number.POSITIVE_INFINITY,
  })
  if (article.isPending) return <Skeleton className="h-40 w-full" />
  if (article.data === null || article.data === undefined)
    return (
      <p className="text-sm text-ws-muted-fg" data-testid="help-missing">
        {t('help.missing')}
      </p>
    )
  return <HelpArticle markdown={article.data} />
}

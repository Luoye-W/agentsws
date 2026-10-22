/**
 * 教程上官网（私有 docs/113 §4.3）：右栏「教程」的数据。
 *
 * 目录与正文都问本机服务（它挑好用官网拉回来的还是随包的）；本机服务没回来（还没起好、演示、单测）
 * 就用随包那份——**先出东西、不转圈**，回来了再无声换上。
 */
import type { HelpArticleView, HelpCatalogEntry } from '@agentsws/contracts'
import { useQuery } from '@tanstack/react-query'
import { getHelpArticle, getHelpCatalog } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { bundledHelpCatalog, isBundledHelp, loadHelpArticle, rememberHelpSlugs } from '@/lib/help'

/** 当前语言的教程目录（只有教程；笔记、更新日志不进右栏）。 */
export function useHelpCatalog(): HelpCatalogEntry[] {
  const { lang } = useApp()
  const online = useQuery({
    queryKey: ['help-catalog', lang],
    queryFn: () => getHelpCatalog(lang),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const items = online.data?.items ?? bundledHelpCatalog(lang)
  if (online.data !== undefined) rememberHelpSlugs(online.data.items.map((i) => i.slug))
  return items.filter((i) => i.kind === 'guide')
}

/** 随包那一篇拼成同一种形状（本机服务没回来时用）。 */
async function bundledArticle(slug: string, lang: 'zh' | 'en'): Promise<HelpArticleView | null> {
  if (!isBundledHelp(slug)) return null
  const markdown = await loadHelpArticle(slug, lang)
  if (markdown === undefined) return null
  const entry = bundledHelpCatalog(lang).find((e) => e.slug === slug)
  if (entry === undefined) return null
  return { ...entry, markdown, newer_online: false }
}

/** 一篇的正文：先本机服务，不行就随包的；哪份都没有回 `null`。 */
export function useHelpArticle(slug: string): {
  article: HelpArticleView | null | undefined
  pending: boolean
} {
  const { lang } = useApp()
  const q = useQuery({
    queryKey: ['help-article', slug, lang],
    queryFn: async () => {
      try {
        return await getHelpArticle(slug, lang)
      } catch {
        return bundledArticle(slug, lang)
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
  return { article: q.data, pending: q.isPending }
}

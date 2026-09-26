/**
 * WP156（36 §7 第三档）：卡片上的「看教程」小链接。
 *
 * 卡片上不再铺步骤清单、成段介绍与外链——那些进了教程文章（`docs/help/<slug>.md`）。
 * 点这个链接在**右栏「教程」面板**里打开那一篇（`agentsws://help/<slug>`，走注册表的
 * `resolvePanel()`，与知识库里点一份文件同一条路）。
 *
 * 右栏不在（单测里只渲染一张卡、没有 `AppShell`）时 `openAddress` 回假——
 * 那时退回在当前位置弹一个对话框显示同一篇，人照样看得到，不会点了没反应。
 */
import { BookOpenText } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useState } from 'react'
import { useRailState } from '@/components/rail/rail-state'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useApp } from '@/lib/app-context'
import { type HelpSlug, helpAddress } from '@/lib/help'
import { cn } from '@/lib/utils'

const HelpArticleLazy = lazy(async () => {
  const m = await import('@/components/help/help-article')
  return { default: m.HelpArticle }
})

const HelpBody = lazy(async () => {
  const m = await import('@/components/help/help-body')
  return { default: m.HelpBody }
})

export function TutorialLink({
  slug,
  className,
  label,
}: {
  slug: HelpSlug
  className?: string
  /** 默认「看教程」；个别地方要说得更具体（"三个方案怎么选"）。 */
  label?: string
}): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const [fallback, setFallback] = useState(false)
  return (
    <>
      <button
        type="button"
        data-slot="tutorial-link"
        data-testid="tutorial-link"
        data-slug={slug}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 text-[11px] text-primary underline-offset-4 hover:underline',
          className,
        )}
        onClick={() => {
          if (!rail.openAddress(helpAddress(slug))) setFallback(true)
        }}
      >
        <BookOpenText aria-hidden className="size-3.5" />
        {label ?? t('help.open')}
      </button>
      {fallback ? (
        <Dialog open onOpenChange={setFallback}>
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t(`help.${slug}.title`)}</DialogTitle>
            </DialogHeader>
            <Suspense fallback={null}>
              <HelpBody slug={slug} />
            </Suspense>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}

/**
 * 没有写成教程文章的那种（第三方应用包加的模型模板）：它自带的步骤与外链照样一条不丢——
 * 点「看教程」在对话框里按同一套渲染排出来（`markdown` 由调用方从模板拼好）。
 */
export function InlineGuideLink({
  title,
  markdown,
  className,
}: {
  title: string
  markdown: string
  className?: string
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        data-slot="tutorial-link"
        data-testid="tutorial-link"
        data-slug=""
        className={cn(
          'inline-flex shrink-0 items-center gap-1 text-[11px] text-primary underline-offset-4 hover:underline',
          className,
        )}
        onClick={() => {
          setOpen(true)
        }}
      >
        <BookOpenText aria-hidden className="size-3.5" />
        {t('help.open')}
      </button>
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <Suspense fallback={null}>
              <HelpArticleLazy markdown={markdown} />
            </Suspense>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}

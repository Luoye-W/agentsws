/**
 * WP156（36 §7 第三档）：卡片上的「看教程」——Luoye 10-23 起是一个**书本图标**（悬停提示「看教程」）。
 *
 * 在设置弹窗里（{@link TutorialOpensSite}）点它：系统浏览器打开官网那一篇（右栏在弹窗后面，看不到）。
 *
 * 卡片上不再铺步骤清单、成段介绍与外链——那些进了教程文章（`docs/help/<slug>.md`）。
 * 点这个链接在**右栏「教程」面板**里打开那一篇（`agentsws://help/<slug>`，走注册表的
 * `resolvePanel()`，与知识库里点一份文件同一条路）。
 *
 * 右栏不在（单测里只渲染一张卡、没有 `AppShell`）时 `openAddress` 回假——
 * 那时退回在当前位置弹一个对话框显示同一篇，人照样看得到，不会点了没反应。
 */
import { BookOpen } from 'lucide-react'
import { createContext, lazy, type ReactNode, Suspense, useContext, useState } from 'react'
import { openExternal } from '@/components/connections/bridge'
import { useRailState } from '@/components/rail/rail-state'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp } from '@/lib/app-context'
import { type HelpSlug, helpAddress, helpSiteUrl, helpTitle } from '@/lib/help'
import { cn } from '@/lib/utils'

const HelpArticleLazy = lazy(async () => {
  const m = await import('@/components/help/help-article')
  return { default: m.HelpArticle }
})

const HelpBody = lazy(async () => {
  const m = await import('@/components/help/help-body')
  return { default: m.HelpBody }
})

/**
 * Luoye 10-23：设置是盖在页面上的大弹窗，右栏开在它后面被挡住——**设置里的「看教程」一律跳官网那一篇**
 * （系统默认浏览器，中英按界面语言）。设置弹窗用 {@link TutorialOpensSite} 包一层就行。
 */
const OpensSite = createContext(false)

export function TutorialOpensSite({ children }: { children: ReactNode }): ReactNode {
  return <OpensSite.Provider value>{children}</OpensSite.Provider>
}

/** 书本图标 + 悬停提示（Luoye 10-23：全站「看教程」不再是文字链接）。 */
function BookButton({
  tip,
  slug,
  className,
  onClick,
}: {
  tip: string
  slug: string
  className?: string | undefined
  onClick: () => void
}): ReactNode {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="tutorial-link"
            data-testid="tutorial-link"
            data-slug={slug}
            aria-label={tip}
            className={cn(
              'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ws-muted-fg hover:bg-accent hover:text-primary',
              className,
            )}
            onClick={onClick}
          >
            <BookOpen aria-hidden className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function TutorialLink({
  slug,
  className,
  label,
}: {
  slug: HelpSlug
  className?: string
  /** 悬停提示，默认「看教程」；个别地方要说得更具体（"三个方案怎么选"）。 */
  label?: string
}): ReactNode {
  const { t, lang } = useApp()
  const rail = useRailState()
  const toSite = useContext(OpensSite)
  const [fallback, setFallback] = useState(false)
  return (
    <>
      <BookButton
        tip={label ?? t('help.open')}
        slug={slug}
        className={className}
        onClick={() => {
          if (toSite) openExternal(helpSiteUrl(slug, lang))
          else if (!rail.openAddress(helpAddress(slug))) setFallback(true)
        }}
      />
      {fallback ? (
        <Dialog open onOpenChange={setFallback}>
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{helpTitle(slug, lang)}</DialogTitle>
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
      <BookButton
        tip={t('help.open')}
        slug=""
        className={className}
        onClick={() => {
          setOpen(true)
        }}
      />
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

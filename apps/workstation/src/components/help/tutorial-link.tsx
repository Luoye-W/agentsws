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
import { CircleHelp } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useState } from 'react'
import { useRailState } from '@/components/rail/rail-state'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
        // WP456-T6（§2.6 第 10 条）：「看教程」是次要动作——全站一种样子：灰字 + 下划线（`ws-link-muted`），
        // 不再是绿字带书本图标（模型页是灰的、连接页是绿的，两样）
        className={cn('ws-link-muted inline-flex shrink-0 items-center text-xs', className)}
        onClick={() => {
          if (!rail.openAddress(helpAddress(slug))) setFallback(true)
        }}
      >
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
        // WP456-T6（§2.6 第 10 条）：「看教程」是次要动作——全站一种样子：灰字 + 下划线（`ws-link-muted`），
        // 不再是绿字带书本图标（模型页是灰的、连接页是绿的，两样）
        className={cn('ws-link-muted inline-flex shrink-0 items-center text-xs', className)}
        onClick={() => {
          setOpen(true)
        }}
      >
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

/**
 * WP456-T6（§3.8「问号里放教程链接，去掉『看教程』」）：一行里只留**一个问号**——
 * 悬停 / 聚焦出那几句介绍（和 `<Hint>` 一样，原话一字不少），点它打开教程
 * （有文章的在右栏「教程」里开，没有的把步骤与外链在对话框里现拼）。
 * 连接列表、模型列表每一行右边就是它，不再是「ⓘ + 看教程」两颗。
 *
 * 和 `<Hint>` 一样把那几句写进 `aria-label` / `data-hint`（jsdom 里 tooltip 打不开，测试照样拿得到）。
 */
export function TutorialHint({
  slug,
  guide,
  text,
  testId = 'tutorial-link',
  className,
}: {
  /** 有教程文章：点了在右栏打开这一篇。 */
  slug?: HelpSlug | undefined
  /** 没有文章：点了在对话框里排这一小篇（标题 + markdown）。两样都没有 = 只是个问号。 */
  guide?: { title: string; markdown: string } | undefined
  /** 悬停出的那几句（服务端介绍、连上之后会怎样）；空着就只说「看教程」。 */
  text?: string | undefined
  testId?: string
  className?: string
}): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const [open, setOpen] = useState<'article' | 'guide' | null>(null)
  const about = (text ?? '').replace(/\*\*/g, '').trim()
  const action = slug !== undefined || guide !== undefined
  const tip = action ? [about, t('help.open.tip')].filter((x) => x !== '').join(' ') : about
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-slot="hint"
              data-testid={testId}
              data-slug={slug ?? ''}
              data-hint={about}
              aria-label={tip}
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ws-muted-fg transition-colors hover:bg-ws-hover hover:text-ws-ink focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                className,
              )}
              onClick={(e) => {
                e.preventDefault()
                if (slug !== undefined) {
                  if (!rail.openAddress(helpAddress(slug))) setOpen('article')
                } else if (guide !== undefined) setOpen('guide')
              }}
            >
              <CircleHelp aria-hidden className="size-4" />
            </button>
          </TooltipTrigger>
          {tip === '' ? null : <TooltipContent className="max-w-80">{tip}</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
      {open === null ? null : (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setOpen(null)
          }}
        >
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {open === 'article' && slug !== undefined ? t(`help.${slug}.title`) : guide?.title}
              </DialogTitle>
            </DialogHeader>
            <Suspense fallback={null}>
              {open === 'article' && slug !== undefined ? (
                <HelpBody slug={slug} />
              ) : (
                <HelpArticleLazy markdown={guide?.markdown ?? ''} />
              )}
            </Suspense>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

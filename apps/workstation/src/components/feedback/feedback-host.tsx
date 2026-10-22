/**
 * WP475：外壳里那一份反馈框——左下角按钮、⌘K「反馈」、铃铛（`?feedback=mine`）都打开它。
 *
 * 表单的值在这里拿着：桌面壳里点「附上截图」时框先收起（截到的不该是反馈框自己）、截完再打开，
 * 写了一半的字不丢。
 */
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  EMPTY_FORM,
  FeedbackDialog,
  type FeedbackForm,
} from '@/components/feedback/feedback-dialog'
import { useApp } from '@/lib/app-context'
import { desktopVersion } from '@/lib/app-version'
import {
  captureBridge,
  FEEDBACK_KEY,
  type FeedbackTab,
  feedbackTabOf,
  getFeedbackDraft,
  inDesktop,
  onOpenFeedback,
} from '@/lib/feedback'

/** 框收起之后等多久再截（关的动画 100ms，留足一点）。 */
const CAPTURE_SETTLE_MS = 220

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve()
    })
  })

export function FeedbackHost(): ReactNode {
  const { lang, t } = useApp()
  const { pathname } = useLocation()
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<FeedbackTab>('new')
  const [form, setForm] = useState<FeedbackForm>(EMPTY_FORM)
  const [capturing, setCapturing] = useState(false)
  const [captureFailed, setCaptureFailed] = useState(false)

  const show = useCallback((which: FeedbackTab) => {
    setTab(which)
    setOpen(true)
  }, [])
  useEffect(() => onOpenFeedback(show), [show])

  // 铃铛 / 托盘带过来的 `?feedback=mine`：打开，再把参数拿掉（刷新不再弹）
  const param = params.get('feedback')
  useEffect(() => {
    const which = feedbackTabOf(param)
    if (which === undefined) return
    show(which)
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('feedback')
        return next
      },
      { replace: true },
    )
  }, [param, setParams, show])

  const app_version = desktopVersion()
  const page = {
    route: pathname,
    locale: lang === 'en' ? 'en' : 'zh-CN',
    ...(app_version === undefined ? {} : { app_version }),
    shell: inDesktop() ? ('desktop' as const) : ('browser' as const),
  }
  const draft = useQuery({
    queryKey: [...FEEDBACK_KEY, 'draft', page.route, page.locale],
    queryFn: () => getFeedbackDraft(page),
    enabled: open,
    retry: false,
    staleTime: 0,
  })

  const capture = captureBridge()
  const onCapture =
    capture === undefined
      ? undefined
      : async (): Promise<void> => {
          setCapturing(true)
          setOpen(false)
          try {
            await new Promise((r) => setTimeout(r, CAPTURE_SETTLE_MS))
            await nextFrame()
            await nextFrame()
            const shot = await capture()
            if (shot === null) setCaptureFailed(true)
            else {
              setCaptureFailed(false)
              setForm((f) => ({ ...f, screenshot: shot }))
            }
          } catch {
            setCaptureFailed(true)
          } finally {
            setCapturing(false)
            setOpen(true)
          }
        }

  return (
    <FeedbackDialog
      open={open}
      onOpenChange={(next) => {
        if (!capturing) setOpen(next)
      }}
      tab={tab}
      onTab={setTab}
      form={form}
      onForm={setForm}
      {...(draft.data === undefined ? {} : { draft: draft.data })}
      page={page}
      {...(onCapture === undefined || captureFailed
        ? {}
        : {
            onCapture: () => {
              void onCapture()
            },
          })}
      capturing={capturing}
      {...(captureFailed && form.screenshot === undefined
        ? { shotNotice: t('feedback.shot.failed') }
        : {})}
    />
  )
}

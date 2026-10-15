/**
 * WP337（Luoye 10-15）：点「重启并更新」时还有任务在做——问一句。
 *
 * 少字（docs/96 P6）：一句「还有 N 件在做」+ 三个按钮；清单折起来，点「看看是哪些」才展开
 * （每件一行：图标分三类——正在输出 / 定时 / 后台）。「暂停的会自动接着做」只是一行灰字。
 *
 * - 现在重启：暂停全部 → 重启更新 → 新版打开后自动接着做；
 * - 空闲时重启：等到没有正在输出的再走（按钮变「等空闲后重启」，点一下取消）；
 * - 稍后：关框，什么都不动。
 */
import { ChevronDown, ChevronUp, Clock, Cog, MessageCircle } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useApp } from '@/lib/app-context'

/** 形状同 `@agentsws/desktop/bridge` 的 `DesktopRestartReadiness`。 */
export interface RestartReadinessView {
  total: number
  idle: boolean
  counts: { output: number; background: number; scheduled: number }
  items: { kind: 'output' | 'background' | 'scheduled'; title: string }[]
}

const ICONS = { output: MessageCircle, scheduled: Clock, background: Cog } as const

export function UpdateRestartDialog({
  readiness,
  busy,
  onChoose,
  onClose,
}: {
  /** 不给 = 框不开。 */
  readiness: RestartReadinessView | undefined
  busy?: boolean
  onChoose: (choice: 'now' | 'idle') => void
  onClose: () => void
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const items = readiness?.items ?? []
  const more = (readiness?.total ?? 0) - items.length
  return (
    <Dialog
      open={readiness !== undefined}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent data-testid="update-restart-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('update.busy.title', { n: readiness?.total ?? 0 })}</DialogTitle>
          <DialogDescription>{t('update.busy.hint')}</DialogDescription>
        </DialogHeader>
        {items.length === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              data-testid="update-restart-toggle"
              className="flex w-fit items-center gap-1 text-[12px] text-ws-muted-fg hover:text-foreground"
              onClick={() => {
                setOpen((v) => !v)
              }}
            >
              {open ? (
                <ChevronUp aria-hidden className="size-3.5" />
              ) : (
                <ChevronDown aria-hidden className="size-3.5" />
              )}
              {t(open ? 'update.busy.hide' : 'update.busy.show')}
            </button>
            {open ? (
              <ul
                className="flex max-h-56 flex-col gap-1 overflow-y-auto"
                data-testid="update-restart-items"
              >
                {items.map((item, i) => {
                  const Icon = ICONS[item.kind]
                  return (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: 同名的两件也要各占一行
                      key={`${item.kind}-${i}`}
                      className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
                      title={t(`update.busy.${item.kind}`)}
                    >
                      <Icon
                        aria-label={t(`update.busy.${item.kind}`)}
                        className="size-3.5 shrink-0 text-ws-muted-fg"
                      />
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    </li>
                  )
                })}
                {more > 0 ? (
                  <li className="px-2.5 text-[12px] text-ws-muted-fg">
                    {t('update.busy.more', { n: more })}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" data-testid="update-restart-later" onClick={onClose}>
            {t('update.restart.later')}
          </Button>
          <Button
            variant="outline"
            data-testid="update-restart-idle"
            disabled={busy === true}
            onClick={() => {
              onChoose('idle')
            }}
          >
            {t('update.restart.idle')}
          </Button>
          <Button
            data-testid="update-restart-now"
            disabled={busy === true}
            onClick={() => {
              onChoose('now')
            }}
          >
            {t('update.restart.now')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

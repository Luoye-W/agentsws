/**
 * WP248（决策 82，Luoye 10-07）：看板上把待办拖到「排着的」时，先问一句「排到什么时候」。
 *
 * 「排着的」= 排在以后某个时段（`todoGroupOf`：没开始、`scheduled.start` 在以后）。光拖一下没有时间
 * 可记，所以弹这个框：默认明天上午 09:00，选好点「排上」才落；点取消 / 关掉就什么都不改，
 * 卡片还在原来那一列（看板从不先改本地数据，落了才重取）。
 */
import type { PositionWorkItem } from '@agentsws/contracts'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useApp } from '@/lib/app-context'
import { defaultQueueAt, queueSlotOf, toLocalInput } from '@/lib/position-work'

export function WorkQueueDialog({
  item,
  now,
  busy,
  onCancel,
  onConfirm,
}: {
  /** 正在问的那条待办；`undefined` = 框关着 */
  item: PositionWorkItem | undefined
  now: Date
  busy: boolean
  onCancel(): void
  onConfirm(slot: { start: string; end: string }): void
}): ReactNode {
  return (
    <Dialog
      open={item !== undefined}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      {item === undefined ? null : (
        <QueueForm
          key={item.id}
          item={item}
          now={now}
          busy={busy}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </Dialog>
  )
}

function QueueForm({
  item,
  now,
  busy,
  onCancel,
  onConfirm,
}: {
  item: PositionWorkItem
  now: Date
  busy: boolean
  onCancel(): void
  onConfirm(slot: { start: string; end: string }): void
}): ReactNode {
  const { t } = useApp()
  const [value, setValue] = useState(() => toLocalInput(defaultQueueAt(now)))
  const slot = queueSlotOf(value, now)
  return (
    <DialogContent className="sm:max-w-sm" data-testid="work-queue-dialog">
      <DialogHeader>
        <DialogTitle>{t('pos2.queue.title')}</DialogTitle>
        <DialogDescription className="truncate" title={item.title}>
          {item.title}
        </DialogDescription>
      </DialogHeader>
      <Input
        type="datetime-local"
        data-testid="work-queue-at"
        aria-label={t('pos2.queue.title')}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
        }}
      />
      {slot === undefined ? (
        <p className="text-xs text-ws-bad" data-testid="work-queue-invalid">
          {t('pos2.queue.future')}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" size="sm" data-testid="work-queue-cancel" onClick={onCancel}>
          {t('pos2.queue.cancel')}
        </Button>
        <Button
          size="sm"
          data-testid="work-queue-confirm"
          disabled={busy || slot === undefined}
          onClick={() => {
            if (slot !== undefined) onConfirm(slot)
          }}
        >
          {t('pos2.queue.confirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

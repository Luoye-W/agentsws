/**
 * WP278（决策 278）：退出之前**先问他一句**——② 「同事」tab 的「退出」、③ 开公司时那张卡上的「我要退出」
 * 都走这一个框。
 *
 * 框里只有三样：一句标题、一句会怎样、（有的话）会一起断开的个人连接的名字。共用的留下，写在那一行的
 * 括号里，不另起一句。确认后才真的退出；他自己接的、标「个人」的连接由服务端断开、凭据删掉。
 */
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { previewLeave } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'

export function LeaveConfirm({
  open,
  workspaceId,
  assignment,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean
  workspaceId: string | undefined
  /** 用哪条分配去问（卡片上点的：那张卡的岗位）。不给 = 当前那条。 */
  assignment?: string | undefined
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.ReactNode {
  const { t } = useApp()
  const preview = useQuery({
    queryKey: ['leave-preview', workspaceId, assignment],
    queryFn: () => previewLeave(workspaceId ?? '', assignment),
    enabled: open && workspaceId !== undefined,
    retry: false,
  })
  const personal = preview.data?.personal_connections ?? []
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent data-testid="leave-confirm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('team.leave.title')}</DialogTitle>
          <DialogDescription>{t('team.leave.body')}</DialogDescription>
        </DialogHeader>
        {personal.length === 0 ? null : (
          <div className="flex flex-col gap-1.5 text-sm" data-testid="leave-personal">
            <p className="text-muted-foreground">{t('team.leave.personal')}</p>
            <ul className="flex flex-col gap-1">
              {personal.map((c) => (
                <li
                  key={c.id}
                  className="rounded-md border px-2.5 py-1.5"
                  data-testid="leave-personal-item"
                >
                  {c.label}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="leave-confirm-ok"
            disabled={busy === true || preview.isFetching}
            onClick={onConfirm}
          >
            {t('team.leave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
